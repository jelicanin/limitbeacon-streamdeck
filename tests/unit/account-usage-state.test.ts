import assert from "node:assert/strict";
import test from "node:test";

import {
  mapLimitGroups,
  type UsageCollection,
} from "../../src/domain/limit-groups.js";
import { UsageValidationError } from "../../src/domain/usage.js";
import type { TokenUsageSnapshot } from "../../src/domain/token-usage.js";
import { UsageService } from "../../src/services/usage-service.js";

function collection(
  accountId: string | null,
  ordinaryUsageAllowed: boolean | null,
  used = 10,
): UsageCollection {
  return mapLimitGroups({
    accountId,
    ordinaryUsageAllowed,
    rateLimitsByLimitId: { codex: { primary: { usedPercent: used } } },
  });
}

function tokens(capturedAt: number): TokenUsageSnapshot {
  return {
    capturedAt,
    stale: false,
    daily: [],
    summary: {
      currentStreakDays: null,
      lifetimeTokens: capturedAt,
      longestRunningTurnSec: null,
      longestStreakDays: null,
      peakDailyTokens: null,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("account notification clears cached quota and token-only surfaces even without account IDs", async (t) => {
  let notify!: () => void;
  let tokenReads = 0;
  const service = new UsageService({
    read: async () => collection(null, null),
    readTokenUsage: async () => tokens(++tokenReads),
    subscribeAccountUpdates: (callback: () => void) => { notify = callback; return () => {}; },
    close: async () => {},
  });
  t.after(() => service.close());
  await service.refresh();
  service.subscribeTokenUsage(() => {});
  await service.refreshTokenUsage();
  notify();
  assert.equal(service.getState().snapshot, null);
  assert.equal(service.getTokenUsageState().snapshot, null);
  await service.refreshTokenUsage();
  assert.equal(service.getTokenUsageState().snapshot?.capturedAt, 2);
});

test("an old quota response cannot overwrite data after an account notification", async (t) => {
  let notify!: () => void;
  const pending = deferred<UsageCollection>();
  let reads = 0;
  const service = new UsageService({
    read: () => ++reads === 1 ? pending.promise : Promise.resolve(collection(null, null, 30)),
    readTokenUsage: async () => tokens(1),
    subscribeAccountUpdates: (callback: () => void) => { notify = callback; return () => {}; },
    close: async () => {},
  });
  t.after(() => service.close());
  const old = service.refresh();
  const rejected = assert.rejects(old);
  await Promise.resolve();
  notify();
  await service.refresh();
  pending.resolve(collection(null, null, 10));
  await rejected;
  assert.equal(service.getState().snapshot?.fiveHour?.remainingPercent, 70);
});

for (const permission of [false, true, null]) {
  test(`mapping preserves backend permission ${permission} and opaque account identity`, () => {
    const mapped = collection("synthetic-A", permission);
    assert.equal(mapped.accountId, "synthetic-A");
    assert.equal(mapped.ordinaryUsageAllowed, permission);
    assert.equal(
      mapped.groups[0]?.snapshot?.accountHealth.ordinaryUsageAllowed,
      permission,
    );
    assert.equal(mapped.groups[0]?.snapshot?.fiveHour?.remainingPercent, 90);
  });
}

test("legacy mapping marks absent identity and permission unavailable", () => {
  const mapped = mapLimitGroups({
    rateLimits: { primary: { usedPercent: 10 } },
  });
  assert.equal(mapped.accountId, null);
  assert.equal(mapped.ordinaryUsageAllowed, null);
  assert.equal(
    mapped.groups[0]?.snapshot?.accountHealth.ordinaryUsageAllowed,
    null,
  );
});

test("invalid permission does not masquerade as an allowed response", () => {
  assert.throws(
    () =>
      mapLimitGroups({
        ordinaryUsageAllowed: "false",
        rateLimits: { primary: { usedPercent: 10 } },
      }),
    UsageValidationError,
  );
});

test("only explicit permission clears a known account's blocked state", async (t) => {
  const incoming = [
    collection("synthetic-A", false),
    collection("synthetic-A", null, 0),
    collection("synthetic-A", true, 0),
  ];
  const service = new UsageService({
    read: async () => incoming.shift()!,
    readTokenUsage: async () => tokens(1),
    close: async () => {},
  });
  t.after(() => service.close());
  await service.refresh();
  await service.refresh();
  assert.equal(
    service.getState().snapshot?.accountHealth.ordinaryUsageAllowed,
    false,
  );
  assert.equal(service.getState().snapshot?.fiveHour?.remainingPercent, 100);
  await service.refresh();
  assert.equal(
    service.getState().snapshot?.accountHealth.ordinaryUsageAllowed,
    true,
  );
});

test("account-wide permission updates still apply when a bucket retains stale usage", async (t) => {
  const incoming = [
    collection("synthetic-A", false),
    collection("synthetic-A", true, 900),
  ];
  const service = new UsageService({
    read: async () => incoming.shift()!,
    readTokenUsage: async () => tokens(1),
    close: async () => {},
  });
  t.after(() => service.close());
  await service.refresh();
  await service.refresh();
  assert.equal(service.getState().snapshot?.stale, true);
  assert.equal(
    service.getState().snapshot?.accountHealth.ordinaryUsageAllowed,
    true,
  );
});

test("unavailable identity does not attribute an earlier denial to the current account", async (t) => {
  const incoming = [
    collection(null, false),
    collection(null, null, 0),
    collection(null, true, 0),
  ];
  const service = new UsageService({
    read: async () => incoming.shift()!,
    readTokenUsage: async () => tokens(1),
    close: async () => {},
  });
  t.after(() => service.close());
  await service.refresh();
  await service.refresh();
  assert.equal(
    service.getState().snapshot?.accountHealth.ordinaryUsageAllowed,
    null,
  );
  await service.refresh();
  assert.equal(
    service.getState().snapshot?.accountHealth.ordinaryUsageAllowed,
    true,
  );
});

for (const [previous, next] of [
  ["synthetic-A", "synthetic-B"],
  ["synthetic-A", null],
  [null, "synthetic-A"],
] as const) {
  test(`identity boundary ${previous} to ${next} drops another account's stale quota`, async (t) => {
    const incoming = [collection(previous, false), collection(next, null, 900)];
    const service = new UsageService({
      read: async () => incoming.shift()!,
      readTokenUsage: async () => tokens(1),
      close: async () => {},
    });
    t.after(() => service.close());
    await service.refresh();
    await service.refresh();
    assert.equal(service.getState().snapshot, null);
    assert.equal(service.getState().collection?.groups[0]?.snapshot, null);
  });
}

test("legacy responses without account identity do not reuse an invalid group's old quota", async (t) => {
  const incoming = [collection(null, null), collection(null, null, 900)];
  const service = new UsageService({
    read: async () => incoming.shift()!,
    readTokenUsage: async () => tokens(1),
    close: async () => {},
  });
  t.after(() => service.close());
  await service.refresh();
  await service.refresh();
  assert.equal(service.getState().snapshot, null);
});

test("known account change clears cached token usage", async (t) => {
  const incoming = [
    collection("synthetic-A", null),
    collection("synthetic-B", null),
  ];
  const service = new UsageService({
    read: async () => incoming.shift()!,
    readTokenUsage: async () => tokens(1),
    close: async () => {},
  });
  t.after(() => service.close());
  await service.refresh();
  await service.refreshTokenUsage();
  await service.refresh();
  assert.equal(service.getTokenUsageState().snapshot, null);
  assert.equal(service.getTokenUsageState().status, "idle");
});

for (const outcome of ["success", "failure"] as const) {
  test(`old token ${outcome} cannot repopulate state after an account change`, async (t) => {
    const pending = deferred<TokenUsageSnapshot>();
    const incoming = [
      collection("synthetic-A", null),
      collection("synthetic-B", null),
    ];
    let reads = 0;
    const service = new UsageService({
      read: async () => incoming.shift()!,
      readTokenUsage: () =>
        ++reads === 1 ? pending.promise : Promise.resolve(tokens(2)),
      close: async () => {},
    });
    t.after(() => service.close());
    await service.refresh();
    const old = service.refreshTokenUsage();
    const oldRejected = assert.rejects(old);
    await service.refresh();
    const fresh = service.refreshTokenUsage();
    assert.notEqual(fresh, old);
    await fresh;
    if (outcome === "success") pending.resolve(tokens(1));
    else pending.reject(new Error("Old account request failed"));
    await oldRejected;
    assert.equal(service.getTokenUsageState().snapshot?.capturedAt, 2);
    assert.equal(service.getTokenUsageState().status, "ready");
  });
}

test("visible token surfaces refresh automatically after identity invalidation", async (t) => {
  const incoming = [
    collection("synthetic-A", null),
    collection("synthetic-B", null),
  ];
  let reads = 0;
  const service = new UsageService({
    read: async () => incoming.shift()!,
    readTokenUsage: async () => tokens(++reads),
    close: async () => {},
  });
  t.after(() => service.close());
  await service.refresh();
  const seen: Array<number | null> = [];
  service.subscribeTokenUsage((state) =>
    seen.push(state.snapshot?.capturedAt ?? null),
  );
  await service.refreshTokenUsage();
  seen.length = 0;
  await service.refresh();
  await service.refreshTokenUsage();
  assert.ok(seen.includes(null));
  assert.equal(service.getTokenUsageState().snapshot?.capturedAt, 2);
});
