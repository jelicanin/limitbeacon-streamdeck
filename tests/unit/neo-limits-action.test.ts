import assert from "node:assert/strict";
import test from "node:test";
import {
  NeoLimitsController,
  type NeoTarget,
} from "../../src/actions/neo-limits-action.js";
import { mapLimitGroups } from "../../src/domain/limit-groups.js";
import type {
  UsageServiceState,
  UsageSubscriber,
} from "../../src/services/usage-service.js";
import type { InspectorPayload } from "../../src/ui/inspector-connection.js";

class Service {
  state: UsageServiceState = {
    status: "ready",
    snapshot: null,
    error: null,
    collection: mapLimitGroups(
      {
        rateLimitsByLimitId: {
          codex: {
            primary: {
              usedPercent: 20,
              windowDurationMins: 300,
              resetsAt: null,
            },
          },
          extra: {
            limitName: "Team",
            primary: {
              usedPercent: 70,
              windowDurationMins: 15,
              resetsAt: null,
            },
          },
        },
      },
      1234,
    ),
  };
  listeners = new Set<UsageSubscriber>();
  subscribe(fn: UsageSubscriber) {
    this.listeners.add(fn);
    fn(this.state);
    return () => {
      this.listeners.delete(fn);
    };
  }
  async refresh() {
    for (const fn of this.listeners) fn(this.state);
    return this.state;
  }
}
class Target implements NeoTarget {
  calls: string[] = [];
  constructor(readonly id: string) {}
  async setFeedbackLayout(layout: string) {
    this.calls.push(layout);
  }
  async setFeedback(value: { canvas: string }) {
    this.calls.push(decodeURIComponent(value.canvas));
  }
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("Neo sets layout before feedback on every appearance and removes subscriptions on disappearance", async () => {
  const service = new Service();
  const controller = new NeoLimitsController(service);
  const target = new Target("neo");
  controller.appear(target, {});
  await flush();
  assert.equal(target.calls[0], "layouts/neo-limits.json");
  assert.match(target.calls[1]!, /80%/);
  controller.disappear("neo");
  assert.equal(service.listeners.size, 0);
  const count = target.calls.length;
  await service.refresh();
  await flush();
  assert.equal(target.calls.length, count);
  controller.appear(target, {});
  await flush();
  assert.equal(target.calls[count], "layouts/neo-limits.json");
});

test("Neo group changes immediately update only that instance and its inspector", async () => {
  const service = new Service();
  const controller = new NeoLimitsController(service);
  const first = new Target("first");
  const other = new Target("other");
  const messages: InspectorPayload[] = [];
  controller.appear(first, {});
  controller.appear(other, {});
  await flush();
  controller.inspectorAppeared("first", async (p) => {
    messages.push(p);
  });
  controller.settingsChanged("first", { limitGroupId: "extra" });
  await flush();
  assert.match(first.calls.at(-1)!, /30%/);
  assert.match(other.calls.at(-1)!, /80%/);
  assert.equal(messages.at(-1)?.lastSuccessAt, 1234);
  controller.settingsChanged("first", { limitGroupId: "gone" });
  await flush();
  assert.match(first.calls.at(-1)!, /Group unavailable/);
  assert.equal(messages.at(-1)?.status, "group-unavailable");
  controller.inspectorDisappeared("first");
  const count = messages.length;
  await controller.refresh();
  await flush();
  assert.equal(messages.length, count);
});

test("Neo replacement waits for old writes and never publishes queued obsolete feedback", async () => {
  const service = new Service();
  const controller = new NeoLimitsController(service);
  let unblock!: () => void;
  const waiting = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const old = new Target("neo");
  old.setFeedbackLayout = async () => {
    await waiting;
  };
  controller.appear(old, {});
  await flush();
  controller.disappear("neo");
  const replacement = new Target("neo");
  controller.appear(replacement, { limitGroupId: "extra" });
  await flush();
  assert.equal(replacement.calls.length, 0);
  unblock();
  await flush();
  assert.equal(old.calls.length, 0);
  assert.equal(replacement.calls[0], "layouts/neo-limits.json");
  assert.match(replacement.calls.at(-1)!, /30%/);
});

test("Neo replacement waits for in-flight feedback and discards old queued updates", async () => {
  const service = new Service();
  const controller = new NeoLimitsController(service);
  let unblock!: () => void;
  const waiting = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const order: string[] = [];
  const old = new Target("neo");
  old.setFeedback = async (value) => {
    await waiting;
    old.calls.push(decodeURIComponent(value.canvas));
    order.push("old feedback completed");
  };
  controller.appear(old, {});
  await flush();
  assert.deepEqual(old.calls, ["layouts/neo-limits.json"]);
  controller.settingsChanged("neo", { limitGroupId: "gone" });
  controller.disappear("neo");
  const replacement = new Target("neo");
  replacement.setFeedbackLayout = async (layout) => {
    order.push("replacement layout");
    replacement.calls.push(layout);
  };
  controller.appear(replacement, { limitGroupId: "extra" });
  await flush();
  assert.equal(replacement.calls.length, 0);
  unblock();
  await flush();
  assert.deepEqual(order, ["old feedback completed", "replacement layout"]);
  assert.equal(old.calls.length, 2);
  assert.match(old.calls[1]!, /80%/);
  assert.doesNotMatch(old.calls.join(""), /Group unavailable/);
  assert.equal(replacement.calls.length, 2);
  assert.equal(replacement.calls[0], "layouts/neo-limits.json");
  assert.match(replacement.calls[1]!, /30%/);
});

for (const rejectedCommand of ["layout", "feedback"] as const) {
  test(`Neo retries layout then current feedback after a rejected ${rejectedCommand} write`, async () => {
    const service = new Service();
    const controller = new NeoLimitsController(service);
    const target = new Target("neo");
    const attempts: string[] = [];
    let rejectNext = true;
    target.setFeedbackLayout = async (layout) => {
      attempts.push("layout");
      if (rejectNext && rejectedCommand === "layout") {
        rejectNext = false;
        throw new Error("Fixture layout send failure");
      }
      target.calls.push(layout);
    };
    target.setFeedback = async (value) => {
      attempts.push("feedback");
      if (rejectNext && rejectedCommand === "feedback") {
        rejectNext = false;
        throw new Error("Fixture feedback send failure");
      }
      target.calls.push(decodeURIComponent(value.canvas));
    };
    controller.appear(target, {});
    await flush();
    assert.deepEqual(
      attempts,
      rejectedCommand === "layout" ? ["layout"] : ["layout", "feedback"],
    );
    assert.equal(
      target.calls.some((call) => call.includes("80%")),
      false,
    );
    const beforeRetry = attempts.length;
    controller.settingsChanged("neo", { limitGroupId: "extra" });
    await flush();
    assert.deepEqual(attempts.slice(beforeRetry), ["layout", "feedback"]);
    assert.match(target.calls.at(-1)!, /30%/);
    const beforeRefresh = attempts.length;
    await service.refresh();
    await flush();
    assert.deepEqual(attempts.slice(beforeRefresh), ["feedback"]);
    assert.match(target.calls.at(-1)!, /30%/);
  });
}
