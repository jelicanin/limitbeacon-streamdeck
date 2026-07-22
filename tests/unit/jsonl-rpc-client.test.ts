import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";

import {
  JsonlRpcClient,
  JsonlRpcProcessError,
  JsonlRpcProtocolError,
  JsonlRpcRemoteError,
  JsonlRpcTimeoutError,
  type StartOptions,
} from "../../src/providers/jsonl-rpc-client.js";

const fixture = fileURLToPath(new URL("../fixtures/fake-app-server.mjs", import.meta.url));

async function startClient(
  t: TestContext,
  mode = "standard",
  overrides: Partial<StartOptions> = {},
): Promise<JsonlRpcClient> {
  const client = await JsonlRpcClient.start({
    executable: process.execPath,
    args: [fixture, mode],
    initializeParams: {
      clientInfo: {
        name: "limitbeacon_test",
        title: "LimitBeacon Test",
        version: "0.1.0",
      },
    },
    requestTimeoutMs: 250,
    ...overrides,
  });
  t.after(() => client.close());
  return client;
}

test("performs initialize and initialized handshake before requests", async (t) => {
  const client = await startClient(t);

  const status = await client.request<{
    initialized: boolean;
    clientName: string;
  }>("handshake/status", null);

  assert.deepEqual(status, {
    initialized: true,
    clientName: "limitbeacon_test",
  });
});

test("correlates out-of-order responses using monotonic numeric ids", async (t) => {
  const client = await startClient(t);

  const first = client.request<{ value: string; requestId: number }>("delayed", {
    value: "first",
  });
  const second = client.request<{ value: string; requestId: number }>("delayed", {
    value: "second",
  });
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.value, "first");
  assert.equal(secondResult.value, "second");
  assert.equal(secondResult.requestId, firstResult.requestId + 1);
});

test("notifications do not resolve pending requests", async (t) => {
  const client = await startClient(t);

  assert.deepEqual(await client.request("notification-first", null), { value: "response" });
});

test("delivers notifications without affecting the pending response", async (t) => {
  const notifications: Array<{ method: string; params: unknown }> = [];
  const client = await startClient(t, "standard", {
    onNotification: (method, params) => notifications.push({ method, params }),
  });

  assert.deepEqual(await client.request("notification-first", null), { value: "response" });
  assert.deepEqual(notifications, [
    { method: "account/rateLimits/updated", params: { fake: true } },
  ]);
});

test("malformed JSON rejects pending requests as a protocol error", async (t) => {
  const client = await startClient(t);

  await assert.rejects(
    client.request("malformed", null),
    (error: unknown) =>
      error instanceof JsonlRpcProtocolError && error.code === "MALFORMED_JSON",
  );
});

test("preserves JSON-RPC errors as typed local errors", async (t) => {
  const client = await startClient(t);

  await assert.rejects(client.request("remote-error", null), (error: unknown) => {
    assert.ok(error instanceof JsonlRpcRemoteError);
    assert.equal(error.code, -32_000);
    assert.equal(error.message, "Fake service failure");
    assert.deepEqual(error.data, { retryable: false });
    return true;
  });
});

test("request timeout removes the pending entry and ignores a late response", async (t) => {
  const client = await startClient(t);

  await assert.rejects(
    client.request("late", { value: "too late" }, 10),
    JsonlRpcTimeoutError,
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(await client.request("echo", { value: "still healthy" }), {
    value: "still healthy",
  });
});

test("child exit rejects every pending request", async (t) => {
  const client = await startClient(t);

  const results = await Promise.allSettled([
    client.request("hang", { value: 1 }),
    client.request("hang", { value: 2 }),
    client.request("crash-with-pending", null),
  ]);

  for (const result of results) {
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") {
      assert.ok(result.reason instanceof JsonlRpcProcessError);
      assert.equal(result.reason.exitCode, 17);
    }
  }
});

test("close is clean and idempotent", async () => {
  const client = await JsonlRpcClient.start({
    executable: process.execPath,
    args: [fixture, "standard"],
    initializeParams: { clientInfo: { name: "close_test", title: "Close Test", version: "1" } },
    requestTimeoutMs: 250,
  });

  await client.close();
  await client.close();
  await assert.rejects(client.request("echo", null), JsonlRpcProcessError);
});

test("rejects stdout lines larger than the configured bound", async (t) => {
  const client = await startClient(t, "standard", { maxLineBytes: 128 });

  await assert.rejects(
    client.request("long-line", null),
    (error: unknown) =>
      error instanceof JsonlRpcProtocolError && error.code === "LINE_TOO_LONG",
  );
});

test("stderr content is discarded and reduced to a safe reason", async () => {
  await assert.rejects(
    JsonlRpcClient.start({
      executable: process.execPath,
      args: [fixture, "stderr-exit"],
      initializeParams: {
        clientInfo: { name: "stderr_test", title: "Stderr Test", version: "1" },
      },
      requestTimeoutMs: 250,
    }),
    (error: unknown) => {
      assert.ok(error instanceof JsonlRpcProcessError);
      assert.equal(error.diagnosticReason, "STDERR_PRESENT");
      assert.doesNotMatch(String(error), /super-secret-token/);
      return true;
    },
  );
});

test("spawn failure rejects without waiting for an exit event", async () => {
  const missingExecutable = fileURLToPath(
    new URL("../fixtures/definitely-missing-app-server", import.meta.url),
  );

  await assert.rejects(
    Promise.race([
      JsonlRpcClient.start({
        executable: missingExecutable,
        args: [],
        initializeParams: {},
        requestTimeoutMs: 250,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("spawn failure did not settle")), 100),
      ),
    ]),
    (error: unknown) =>
      error instanceof JsonlRpcProcessError && error.diagnosticReason === "SPAWN_FAILED",
  );
});
