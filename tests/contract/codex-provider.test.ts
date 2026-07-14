import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

import {
  CodexAppServerProvider,
  CodexProviderError,
  type RpcClientLike,
} from "../../src/providers/codex-app-server-provider.js";
import {
  JsonlRpcProcessError,
  JsonlRpcRemoteError,
} from "../../src/providers/jsonl-rpc-client.js";

const fixtures = new URL("../fixtures/rate-limits/", import.meta.url);

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(name, fixtures), "utf8"));
}

class FakeRpcClient implements RpcClientLike {
  readonly calls: Array<{ method: string; encodedRequest: string }> = [];
  closeCount = 0;

  constructor(private readonly outcomes: readonly unknown[]) {}

  async request<T>(method: string, params: unknown): Promise<T> {
    this.calls.push({ method, encodedRequest: JSON.stringify({ method, params }) });
    const outcome = this.outcomes[this.calls.length - 1];
    if (outcome instanceof Error) {
      throw outcome;
    }
    return outcome as T;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

test("reads rate limits without serializing a params field", async (t) => {
  const rpc = new FakeRpcClient([await fixture("direct.json")]);
  const provider = new CodexAppServerProvider({ createClient: async () => rpc });
  t.after(() => provider.close());

  await provider.read();

  assert.equal(rpc.calls[0]?.method, "account/rateLimits/read");
  assert.deepEqual(JSON.parse(rpc.calls[0]?.encodedRequest ?? "{}"), {
    method: "account/rateLimits/read",
  });
});

test("maps primary and secondary rate-limit windows", async (t) => {
  const rpc = new FakeRpcClient([await fixture("direct.json")]);
  const provider = new CodexAppServerProvider({ createClient: async () => rpc });
  t.after(() => provider.close());
  const before = Date.now();

  const snapshot = await provider.read();

  assert.ok(snapshot.capturedAt >= before && snapshot.capturedAt <= Date.now());
  assert.equal(snapshot.fiveHour.usedPercent, 24);
  assert.equal(snapshot.fiveHour.remainingPercent, 76);
  assert.equal(snapshot.weekly?.usedPercent, 61);
  assert.equal(snapshot.planLabel, "pro");
});

test("prefers the codex bucket from rateLimitsByLimitId", async (t) => {
  const rpc = new FakeRpcClient([await fixture("by-limit-id.json")]);
  const provider = new CodexAppServerProvider({ createClient: async () => rpc });
  t.after(() => provider.close());

  const snapshot = await provider.read();

  assert.equal(snapshot.fiveHour.usedPercent, 12);
  assert.equal(snapshot.weekly?.usedPercent, 34);
  assert.equal(snapshot.planLabel, "plus");
});

test("preserves an unavailable secondary window", async (t) => {
  const rpc = new FakeRpcClient([await fixture("primary-only.json")]);
  const provider = new CodexAppServerProvider({ createClient: async () => rpc });
  t.after(() => provider.close());

  assert.equal((await provider.read()).weekly, null);
});

test("maps the official unauthenticated RPC error to SIGN_IN_REQUIRED", async (t) => {
  const rpc = new FakeRpcClient([
    new JsonlRpcRemoteError(-32_600, "Codex account authentication required to read rate limits"),
  ]);
  const provider = new CodexAppServerProvider({ createClient: async () => rpc });
  t.after(() => provider.close());

  await assert.rejects(
    provider.read(),
    (error: unknown) =>
      error instanceof CodexProviderError && error.code === "SIGN_IN_REQUIRED",
  );
});

test("maps an unknown response shape to CODEX_INCOMPATIBLE", async (t) => {
  const rpc = new FakeRpcClient([await fixture("unknown.json")]);
  const provider = new CodexAppServerProvider({ createClient: async () => rpc });
  t.after(() => provider.close());

  await assert.rejects(
    provider.read(),
    (error: unknown) =>
      error instanceof CodexProviderError && error.code === "CODEX_INCOMPATIBLE",
  );
});

test("restarts the process once after a crash", async (t) => {
  const crashed = new FakeRpcClient([
    new JsonlRpcProcessError("process exited", 17, "PROCESS_EXITED"),
  ]);
  const recovered = new FakeRpcClient([await fixture("direct.json")]);
  const clients = [crashed, recovered];
  let starts = 0;
  const provider = new CodexAppServerProvider({
    createClient: async () => clients[starts++] as FakeRpcClient,
  });
  t.after(() => provider.close());

  assert.equal((await provider.read()).fiveHour.usedPercent, 24);
  assert.equal(starts, 2);
  assert.equal(crashed.closeCount, 1);
});

test("a later read can try again after a failed restart", async (t) => {
  const processError = new JsonlRpcProcessError("process exited", 17, "PROCESS_EXITED");
  const clients = [
    new FakeRpcClient([processError]),
    new FakeRpcClient([processError]),
    new FakeRpcClient([await fixture("direct.json")]),
  ];
  let starts = 0;
  const provider = new CodexAppServerProvider({
    createClient: async () => clients[starts++] as FakeRpcClient,
  });
  t.after(() => provider.close());

  await assert.rejects(
    provider.read(),
    (error: unknown) =>
      error instanceof CodexProviderError && error.code === "CODEX_UNAVAILABLE",
  );
  assert.equal((await provider.read()).fiveHour.usedPercent, 24);
  assert.equal(starts, 3);
});

test("reset closes the current client and reconnects on the next read", async (t) => {
  const first = new FakeRpcClient([await fixture("direct.json")]);
  const second = new FakeRpcClient([await fixture("primary-only.json")]);
  const clients = [first, second];
  let starts = 0;
  const provider = new CodexAppServerProvider({
    createClient: async () => clients[starts++] as FakeRpcClient,
  });
  t.after(() => provider.close());
  await provider.read();

  await provider.reset();
  const next = await provider.read();

  assert.equal(first.closeCount, 1);
  assert.equal(next.fiveHour.usedPercent, 48);
  assert.equal(starts, 2);
});
