import assert from "node:assert/strict";
import test from "node:test";

import type { UsageSnapshot } from "../../src/domain/usage.js";
import type { UsageProvider } from "../../src/providers/codex-app-server-provider.js";
import {
  UsageService,
  type UsageServiceState,
  type UsageServiceTimerDependencies,
} from "../../src/services/usage-service.js";

function snapshot(capturedAt = 1_000): UsageSnapshot {
  return {
    capturedAt,
    fiveHour: {
      usedPercent: 20,
      remainingPercent: 80,
      durationMinutes: 300,
      resetsAt: 10_000,
    },
    weekly: null,
    planLabel: "plus",
    stale: false,
  };
}

class FakeProvider implements UsageProvider {
  readCount = 0;
  closeCount = 0;

  constructor(private readonly outcomes: unknown[]) {}

  async read(): Promise<UsageSnapshot> {
    this.readCount += 1;
    const outcome = this.outcomes.shift();
    if (outcome instanceof Error) {
      throw outcome;
    }
    return await (outcome as UsageSnapshot | Promise<UsageSnapshot>);
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

class FakeTimers implements UsageServiceTimerDependencies {
  #nextId = 1;
  readonly intervals = new Map<number, { callback: () => void; delay: number }>();

  setInterval(callback: () => void, delay: number): number {
    const id = this.#nextId++;
    this.intervals.set(id, { callback, delay });
    return id;
  }

  clearInterval(id: unknown): void {
    this.intervals.delete(id as number);
  }

  fire(delay: number): void {
    for (const interval of [...this.intervals.values()]) {
      if (interval.delay === delay) {
        interval.callback();
      }
    }
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("two subscribers share one provider read", async (t) => {
  const provider = new FakeProvider([snapshot()]);
  const timers = new FakeTimers();
  const service = new UsageService(provider, { timers });
  t.after(() => service.close());
  const first: UsageServiceState[] = [];
  const second: UsageServiceState[] = [];

  service.subscribe((state) => first.push(state));
  service.subscribe((state) => second.push(state));
  await service.refresh();

  assert.equal(provider.readCount, 1);
  assert.equal(first.at(-1)?.status, "ready");
  assert.equal(second.at(-1)?.status, "ready");
});

test("concurrent manual refreshes return the same promise", async (t) => {
  const pending = deferred<UsageSnapshot>();
  const provider = new FakeProvider([pending.promise]);
  const service = new UsageService(provider);
  t.after(() => service.close());

  const first = service.refresh();
  const second = service.refresh();

  assert.equal(first, second);
  pending.resolve(snapshot());
  await first;
  assert.equal(provider.readCount, 1);
});

test("visual rerender emits cached state without reading the provider", async (t) => {
  const provider = new FakeProvider([snapshot()]);
  const service = new UsageService(provider);
  t.after(() => service.close());
  let notifications = 0;
  service.subscribe(() => {
    notifications += 1;
  });
  await service.refresh();
  const before = notifications;

  service.rerender();

  assert.equal(provider.readCount, 1);
  assert.equal(notifications, before + 1);
});

test("default scheduling polls every five minutes", async (t) => {
  const provider = new FakeProvider([snapshot()]);
  const timers = new FakeTimers();
  const service = new UsageService(provider, { timers });
  t.after(() => service.close());

  service.subscribe(() => {});

  assert.deepEqual(
    [...timers.intervals.values()].map(({ delay }) => delay).sort((a, b) => a - b),
    [60_000, 300_000],
  );
});

test("local minute ticks rerender countdowns without provider reads", async (t) => {
  const provider = new FakeProvider([snapshot()]);
  const timers = new FakeTimers();
  const service = new UsageService(provider, { timers });
  t.after(() => service.close());
  let notifications = 0;
  service.subscribe(() => {
    notifications += 1;
  });
  await service.refresh();
  const before = notifications;

  timers.fire(60_000);

  assert.equal(notifications, before + 1);
  assert.equal(provider.readCount, 1);
});

test("changing cadence replaces only the poll timer", async (t) => {
  const provider = new FakeProvider([snapshot()]);
  const timers = new FakeTimers();
  const service = new UsageService(provider, { timers });
  t.after(() => service.close());
  service.subscribe(() => {});
  await service.refresh();

  service.setRefreshInterval(15 * 60_000);

  assert.deepEqual(
    [...timers.intervals.values()].map(({ delay }) => delay).sort((a, b) => a - b),
    [60_000, 900_000],
  );
  assert.equal(provider.readCount, 1);
});

test("temporary errors retain the last successful snapshot as stale", async (t) => {
  const provider = new FakeProvider([snapshot(), new Error("temporary")]);
  const service = new UsageService(provider);
  t.after(() => service.close());
  await service.refresh();

  await assert.rejects(service.refresh(), /temporary/u);

  assert.equal(service.getState().status, "stale");
  assert.equal(service.getState().snapshot?.fiveHour.remainingPercent, 80);
  assert.equal(service.getState().snapshot?.stale, true);
});

test("first-run errors do not fabricate a snapshot", async (t) => {
  const provider = new FakeProvider([new Error("offline")]);
  const service = new UsageService(provider);
  t.after(() => service.close());

  await assert.rejects(service.refresh(), /offline/u);

  assert.equal(service.getState().status, "error");
  assert.equal(service.getState().snapshot, null);
});

test("removing the last subscriber stops both timers", async (t) => {
  const provider = new FakeProvider([snapshot()]);
  const timers = new FakeTimers();
  const service = new UsageService(provider, { timers });
  t.after(() => service.close());
  const unsubscribeFirst = service.subscribe(() => {});
  const unsubscribeSecond = service.subscribe(() => {});
  assert.equal(timers.intervals.size, 2);

  unsubscribeFirst();
  assert.equal(timers.intervals.size, 2);
  unsubscribeSecond();

  assert.equal(timers.intervals.size, 0);
});

test("close closes the provider exactly once", async () => {
  const provider = new FakeProvider([]);
  const service = new UsageService(provider);

  await service.close();
  await service.close();

  assert.equal(provider.closeCount, 1);
});
