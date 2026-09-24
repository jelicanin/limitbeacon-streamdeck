import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CodexAppServerProvider,
  CodexProviderError,
  type RpcClientLike,
} from "../../src/providers/codex-app-server-provider.js";
import {
  JsonlRpcProcessError,
  JsonlRpcClient,
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

test("emits updates only for rate-limit notifications", async (t) => {
  const rpc = new FakeRpcClient([await fixture("direct.json")]);
  let notify!: (method: string, params: unknown) => void;
  const provider = new CodexAppServerProvider({
    createClient: async (onNotification) => {
      notify = onNotification;
      return rpc;
    },
  });
  t.after(() => provider.close());
  let updates = 0;
  provider.subscribeUpdates(() => {
    updates += 1;
  });
  await provider.read();

  notify("account/updated", {});
  notify("account/rateLimits/updated", { rateLimits: { primary: { usedPercent: 25 } } });

  assert.equal(updates, 1);
});

test("preserves an unavailable secondary window", async (t) => {
  const rpc = new FakeRpcClient([await fixture("primary-only.json")]);
  const provider = new CodexAppServerProvider({ createClient: async () => rpc });
  t.after(() => provider.close());

  assert.equal((await provider.read()).weekly, null);
});

test("reads token usage without serializing a params field", async (t) => {
  const rpc = new FakeRpcClient([await fixture("../token-usage/full.json")]);
  const provider = new CodexAppServerProvider({ createClient: async () => rpc });
  t.after(() => provider.close());

  const snapshot = await provider.readTokenUsage();

  assert.equal(rpc.calls[0]?.method, "account/usage/read");
  assert.deepEqual(JSON.parse(rpc.calls[0]?.encodedRequest ?? "{}"), {
    method: "account/usage/read",
  });
  assert.equal(snapshot.daily[0]?.startDate, "2026-07-22");
  assert.equal(snapshot.summary.lifetimeTokens, 123_456_789);
});

test("preserves optional credits and spend data from rate limits", async (t) => {
  const rpc = new FakeRpcClient([await fixture("rich.json")]);
  const provider = new CodexAppServerProvider({ createClient: async () => rpc });
  t.after(() => provider.close());

  const snapshot = await provider.read();

  assert.equal(snapshot.accountHealth.credits?.balance, "12.50");
  assert.equal(snapshot.accountHealth.individualLimit?.remainingPercent, 60);
  assert.equal(snapshot.accountHealth.resetCreditsAvailable, 2);
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("simultaneous limit and token reads share initialization and release their only client", async () => {
  const ready = deferred<RpcClientLike>();
  const rpc = new FakeRpcClient([
    await fixture("direct.json"),
    await fixture("../token-usage/full.json"),
  ]);
  let starts = 0;
  const provider = new CodexAppServerProvider({
    createClient: () => {
      starts += 1;
      return ready.promise;
    },
  });
  const limits = provider.read();
  const tokens = provider.readTokenUsage();
  ready.resolve(rpc);
  try {
    assert.equal((await limits).fiveHour.usedPercent, 24);
    assert.equal((await tokens).summary.lifetimeTokens, 123_456_789);
    assert.equal(starts, 1);
  } finally {
    await provider.close();
  }
  assert.equal(rpc.closeCount, 1);
});

test("close waits for initialization cleanup without allowing a request", async () => {
  const ready = deferred<RpcClientLike>();
  const rpc = new FakeRpcClient([]);
  const provider = new CodexAppServerProvider({ createClient: () => ready.promise });
  const read = assert.rejects(provider.read(), CodexProviderError);
  let closed = false;
  const closing = provider.close().then(() => {
    closed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const returnedEarly = closed;
  ready.resolve(rpc);
  await Promise.all([read, closing]);
  assert.equal(returnedEarly, false);
  assert.equal(rpc.closeCount, 1);
  assert.equal(rpc.calls.length, 0);
  await assert.rejects(provider.read(), CodexProviderError);
});

test("reset waits for old initialization and keeps the new generation independent", async (t) => {
  const ready = deferred<RpcClientLike>();
  const old = new FakeRpcClient([]);
  const fresh = new FakeRpcClient([await fixture("direct.json"), await fixture("direct.json")]);
  let starts = 0;
  const provider = new CodexAppServerProvider({
    createClient: () => ++starts === 1 ? ready.promise : Promise.resolve(fresh),
  });
  t.after(() => provider.close());
  const oldRead = assert.rejects(provider.read(), CodexProviderError);
  let resetDone = false;
  const resetting = provider.reset().then(() => {
    resetDone = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const returnedEarly = resetDone;
  assert.equal((await provider.read()).fiveHour.usedPercent, 24);
  ready.resolve(old);
  await Promise.all([oldRead, resetting]);
  assert.equal(returnedEarly, false);
  assert.equal(old.closeCount, 1);
  assert.equal(old.calls.length, 0);
  assert.equal((await provider.read()).fiveHour.usedPercent, 24);
  assert.equal(starts, 2);
});

test("a malformed response discards its poisoned client so a later refresh recovers", async (t) => {
  let starts = 0;
  const provider = new CodexAppServerProvider({
    createClient: (onNotification) => JsonlRpcClient.start({
      executable: process.execPath,
      args: [
        fileURLToPath(new URL("../fixtures/fake-app-server.mjs", import.meta.url)),
        ++starts === 1 ? "malformed-limits" : "standard",
      ],
      initializeParams: {},
      requestTimeoutMs: 1000,
      onNotification,
    }),
  });
  t.after(() => provider.close());
  await assert.rejects(
    provider.read(),
    (error: unknown) => error instanceof CodexProviderError && error.code === "CODEX_INCOMPATIBLE",
  );
  assert.equal(starts, 1);
  assert.equal((await provider.read()).fiveHour.usedPercent, 24);
  assert.equal(starts, 2);
});

for (const phase of ["initialization", "shutdown"] as const) {
  test(`close waits for reset cleanup during deferred ${phase}`, async () => {
    const ready = deferred<RpcClientLike>();
    const stopped = deferred<void>();
    const rpc = new FakeRpcClient([await fixture("direct.json")]);
    rpc.close = async () => {
      rpc.closeCount += 1;
      await stopped.promise;
    };
    const provider = new CodexAppServerProvider({ createClient: () => ready.promise });
    const reading = provider.read();
    const readFinished = phase === "initialization"
      ? assert.rejects(reading, CodexProviderError)
      : reading;
    if (phase === "shutdown") {
      ready.resolve(rpc);
      await reading;
    }
    const resetting = provider.reset();
    let closeFinished = false;
    const closing = provider.close().then(() => { closeFinished = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const finishedBeforeInitialization = closeFinished;
    ready.resolve(rpc);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const finishedBeforeShutdown = closeFinished;
    stopped.resolve();
    await Promise.all([readFinished, resetting, closing]);
    assert.equal(finishedBeforeInitialization, false);
    assert.equal(finishedBeforeShutdown, false);
    assert.equal(rpc.closeCount, 1);
    assert.equal(rpc.calls.length, phase === "shutdown" ? 1 : 0);
  });
}

test("close waits for discarded client shutdown before resolving", async () => {
  const stopped = deferred<void>();
  const stopping = deferred<void>();
  const rpc = new FakeRpcClient([
    new JsonlRpcProcessError("process exited", 17, "PROCESS_EXITED"),
  ]);
  rpc.close = async () => {
    rpc.closeCount += 1;
    stopping.resolve();
    await stopped.promise;
  };
  const provider = new CodexAppServerProvider({ createClient: async () => rpc });
  const reading = assert.rejects(provider.read(), CodexProviderError);
  await stopping.promise;
  let closeFinished = false;
  const closing = provider.close().then(() => { closeFinished = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const finishedBeforeShutdown = closeFinished;
  stopped.resolve();
  await Promise.all([reading, closing]);
  assert.equal(finishedBeforeShutdown, false);
  assert.equal(rpc.closeCount, 1);
  assert.equal(rpc.calls.length, 1);
});
