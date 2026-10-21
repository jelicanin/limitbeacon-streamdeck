import { mapLimitGroups } from "../../src/domain/limit-groups.js";
import assert from "node:assert/strict";
import test from "node:test";

import { CodexLimitsController } from "../../src/actions/codex-limits-action.js";
import type { UsageServiceState, UsageSubscriber } from "../../src/services/usage-service.js";

const readyState: UsageServiceState = {
  status: "ready",
  error: null,
  snapshot: {
    capturedAt: 1_000,
    fiveHour: {
      usedPercent: 20,
      remainingPercent: 80,
      durationMinutes: 1_440,
      resetsAt: 10_000,
    },
    weekly: null,
    planLabel: "plus",
    accountHealth: {
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      rateLimitReachedType: null,
      resetCreditsAvailable: null,
    },
    stale: false,
  },
};

class FakeService {
  state: UsageServiceState = readyState;
  subscribers = new Set<UsageSubscriber>();
  refreshCount = 0;
  rerenderCount = 0;

  subscribe(subscriber: UsageSubscriber): () => void {
    this.subscribers.add(subscriber);
    subscriber(this.state);
    return () => this.subscribers.delete(subscriber);
  }

  async refresh(): Promise<UsageServiceState> {
    this.refreshCount += 1;
    return this.state;
  }

  rerender(): void {
    this.rerenderCount += 1;
    for (const subscriber of this.subscribers) subscriber(this.state);
  }
}

class FakeKey {
  readonly images: string[] = [];
  okCount = 0;
  alertCount = 0;

  constructor(readonly id: string) {}

  async setImage(image: string): Promise<void> {
    this.images.push(image);
  }

  async showOk(): Promise<void> {
    this.okCount += 1;
  }

  async showAlert(): Promise<void> {
    this.alertCount += 1;
  }
}

function latestSvg(key: FakeKey): string {
  const image = key.images.at(-1) ?? "";
  assert.match(image, /^data:image\/svg\+xml,/u);
  return decodeURIComponent(image.slice("data:image/svg+xml,".length));
}

test("appearing and disappearing keys subscribe and unsubscribe", () => {
  const service = new FakeService();
  const controller = new CodexLimitsController(service);
  const key = new FakeKey("key-1");

  controller.appear(key, {});
  assert.equal(service.subscribers.size, 1);
  assert.match(latestSvg(key), />80%</u);
  assert.match(latestSvg(key), />1D <tspan[^>]*>●<\/tspan> LEFT<\/text>/u);

  controller.disappear(key.id);
  assert.equal(service.subscribers.size, 0);
});

test("key press refreshes once and shows success feedback", async () => {
  const service = new FakeService();
  const controller = new CodexLimitsController(service);
  const key = new FakeKey("key-1");
  controller.appear(key, {});

  await controller.keyDown(key.id);

  assert.equal(service.refreshCount, 1);
  assert.equal(key.okCount, 1);
  assert.equal(key.alertCount, 0);
});

test("key settings changes rerender cache without refreshing", () => {
  const service = new FakeService();
  const controller = new CodexLimitsController(service);
  const key = new FakeKey("key-1");
  controller.appear(key, {});

  controller.keySettingsChanged(key.id, { basis: "used" });

  assert.equal(service.rerenderCount, 1);
  assert.equal(service.refreshCount, 0);
  assert.match(latestSvg(key), />20%</u);
});

test("key display style changes only the selected key", () => {
  const service = new FakeService();
  const controller = new CodexLimitsController(service);
  const ringKey = new FakeKey("ring-key");
  const barKey = new FakeKey("bar-key");
  controller.appear(ringKey, {});
  controller.appear(barKey, {});

  controller.keySettingsChanged(ringKey.id, { displayStyle: "rings" });

  assert.match(latestSvg(ringKey), /class="ring-fill"/u);
  assert.match(latestSvg(barKey), /class="meter-fill"/u);
});

test("two keys keep independent display settings", () => {
  const service = new FakeService();
  const controller = new CodexLimitsController(service);
  const remainingKey = new FakeKey("remaining-key");
  const usedKey = new FakeKey("used-key");

  controller.appear(remainingKey, { basis: "remaining" });
  controller.appear(usedKey, { basis: "remaining" });

  assert.match(latestSvg(remainingKey), />80%</u);
  assert.match(latestSvg(usedKey), />80%</u);

  controller.keySettingsChanged(remainingKey.id, { basis: "used" });

  assert.match(latestSvg(remainingKey), />20%</u);
  assert.match(latestSvg(usedKey), />80%</u);
});

test("two key contexts use the same service", () => {
  const service = new FakeService();
  const controller = new CodexLimitsController(service);

  controller.appear(new FakeKey("key-1"), {});
  controller.appear(new FakeKey("key-2"), {});

  assert.equal(service.subscribers.size, 2);
});

test("error state renders without throwing", () => {
  const service = new FakeService();
  service.state = { status: "error", snapshot: null, error: new Error("offline") };
  const controller = new CodexLimitsController(service);
  const key = new FakeKey("key-1");

  controller.appear(key, {});

  assert.match(latestSvg(key), />Could not refresh</u);
});

test("property inspector receives the current connection status", () => {
  const service = new FakeService();
  const controller = new CodexLimitsController(service);
  controller.appear(new FakeKey("key-1"), {});
  const messages: unknown[] = [];

  controller.inspectorAppeared("key-1", async (payload) => {
    messages.push(payload);
  });

  assert.deepEqual(messages.at(-1), { status: "connected", lastSuccessAt: 1_000 });
});


test("key group selection is independent and never substitutes a missing group", () => {
  const service = new FakeService();
  const collection = mapLimitGroups({rateLimitsByLimitId: {
    codex: {primary: {usedPercent: 10}},
    other: {limitName: "Research", primary: {usedPercent: 70, windowDurationMins: 60}},
  }}, 1000);
  service.state = {...readyState, collection};
  const controller = new CodexLimitsController(service);
  const first = new FakeKey("first");
  const second = new FakeKey("second");
  controller.appear(first, {});
  controller.appear(second, {limitGroupId: "other"});
  assert.match(latestSvg(first), />90%</u);
  assert.match(latestSvg(second), />30%</u);
  assert.match(latestSvg(second), /Research/u);
  controller.keySettingsChanged(first.id, {limitGroupId: "other"});
  assert.match(latestSvg(first), />30%</u);
  assert.equal(service.refreshCount, 0);
  service.state = {...service.state, collection: mapLimitGroups({rateLimitsByLimitId: {codex: {primary: {usedPercent: 20}}}})};
  service.rerender();
  assert.match(latestSvg(second), /Group unavailable/u);
  assert.doesNotMatch(latestSvg(second), />80%</u);
  service.state = {...service.state, collection};
  service.rerender();
  assert.match(latestSvg(second), />30%</u);
  controller.disappear(second.id);
  controller.appear(second, {limitGroupId: "other"});
  assert.match(latestSvg(second), />30%</u);
});


test("key inspector reports the selected group's timestamp and availability", () => {
  const service = new FakeService();
  const collection = mapLimitGroups({rateLimitsByLimitId: {
    codex: {primary: {usedPercent: 10}}, other: {limitName: "Research", primary: {usedPercent: 70}},
  }}, 2000);
  collection.groups.find(group => group.id === "other")!.snapshot!.capturedAt = 1000;
  collection.groups.find(group => group.id === "other")!.snapshot!.stale = true;
  service.state = {...readyState, collection};
  const controller = new CodexLimitsController(service);
  const target = new FakeKey("selected");
  controller.appear(target, {limitGroupId: "other"});
  const sent: unknown[] = [];
  controller.inspectorAppeared(target.id, async payload => {sent.push(payload);});
  assert.equal((sent.at(-1) as {status?: string})?.status, "stale");
  assert.equal((sent.at(-1) as {lastSuccessAt?: number | null})?.lastSuccessAt, 1000);
  assert.equal((sent.at(-1) as {limitGroups?: unknown[]})?.limitGroups?.length, 2);
  controller.keySettingsChanged(target.id, {limitGroupId: "missing"});
  assert.equal((sent.at(-1) as {status?: string})?.status, "group-unavailable");
  assert.equal((sent.at(-1) as {lastSuccessAt?: number | null})?.lastSuccessAt, null);
  controller.inspectorDisappeared(target.id);
  controller.disappear(target.id);
});

for (const displayStyle of ["bars", "rings"] as const) {
  for (const [window, percent, label] of [
    [undefined, "80", "1D"],
    ["automatic", "80", "1D"],
    ["primary", "80", "1D"],
    ["secondary", "35", "7D"],
  ] as const) {
    test(`${displayStyle} key with ${window ?? "legacy"} selection renders exactly one available quota window`, () => {
      const service = new FakeService();
      service.state = {...readyState, snapshot: {...readyState.snapshot!, weekly: {
        usedPercent: 65, remainingPercent: 35, durationMinutes: 10_080, resetsAt: 20_000,
      }}};
      const controller = new CodexLimitsController(service);
      const key = new FakeKey("selected");
      controller.appear(key, {displayStyle, ...(window === undefined ? {} : {window})});
      const svg = latestSvg(key);
      assert.equal(svg.match(/class="(?:meter|ring)-fill"/gu)?.length, 1);
      assert.equal(svg.match(/>\d+%</gu)?.length, 1);
      assert.match(svg, new RegExp(`>${percent}%<`, "u"));
      assert.match(svg, new RegExp(`>${label}(?: ·| <tspan)`, "u"));
      assert.equal(svg.match(/class="single-(?:ring-)?reset"/gu)?.length, 1);
    });
  }
}

for (const window of ["primary", "secondary"] as const) {
  test(`missing selected ${window} window never silently falls back`, () => {
    const service = new FakeService();
    service.state = {...readyState, snapshot: {...readyState.snapshot!,
      fiveHour: window === "primary" ? null : readyState.snapshot!.fiveHour,
      weekly: window === "secondary" ? null : readyState.snapshot!.fiveHour,
    }};
    const controller = new CodexLimitsController(service);
    const selected = new FakeKey("selected");
    const automatic = new FakeKey("automatic");
    controller.appear(selected, {window});
    controller.appear(automatic, {});
    assert.match(latestSvg(selected), />Window unavailable</u);
    assert.doesNotMatch(latestSvg(selected), />\d+%</u);
    assert.match(latestSvg(automatic), />80%</u);
    assert.equal(latestSvg(automatic).match(/class="meter-fill"/gu)?.length, 1);
  });
}

test("window selection is independent per key and rerenders cached group data", () => {
  const service = new FakeService();
  service.state = {...readyState, collection: mapLimitGroups({rateLimitsByLimitId: {
    codex: {primary: {usedPercent: 10}, secondary: {usedPercent: 40}},
    research: {limitName: "Research", primary: {usedPercent: 20}, secondary: {usedPercent: 70, windowDurationMins: 120}},
  }}, 1000)};
  const controller = new CodexLimitsController(service);
  const first = new FakeKey("first");
  const second = new FakeKey("second");
  controller.appear(first, {});
  controller.appear(second, {limitGroupId: "research", window: "secondary", basis: "used", displayStyle: "rings"});
  assert.match(latestSvg(first), />90%</u);
  assert.match(latestSvg(second), />70%</u);
  assert.match(latestSvg(second), />2H · USED</u);
  assert.match(latestSvg(second), />Research</u);
  controller.keySettingsChanged(first.id, {window: "secondary"});
  assert.match(latestSvg(first), />60%</u);
  assert.match(latestSvg(second), />70%</u);
  assert.equal(service.refreshCount, 0);
  service.state = {...service.state, collection: mapLimitGroups({rateLimitsByLimitId: {
    codex: {primary: {usedPercent: 10}}, research: {primary: {usedPercent: 20}},
  }})};
  service.rerender();
  assert.match(latestSvg(first), />Window unavailable</u);
  assert.match(latestSvg(second), />Window unavailable</u);
});

for (const ordinaryUsageAllowed of [false, true, null]) {
  test(`key respects explicit ordinary usage permission ${ordinaryUsageAllowed}`, () => {
    const service = new FakeService();
    service.state = {...readyState, snapshot: {...readyState.snapshot!,
      fiveHour: {...readyState.snapshot!.fiveHour!, remainingPercent: 90, usedPercent: 10},
      accountHealth: {...readyState.snapshot!.accountHealth, ordinaryUsageAllowed},
    }};
    const controller = new CodexLimitsController(service);
    const key = new FakeKey("permission");
    controller.appear(key, {});
    const svg = latestSvg(key);
    if (ordinaryUsageAllowed === false) {
      assert.match(svg, />Usage blocked</u);
      assert.match(svg, />Check Codex</u);
      assert.doesNotMatch(svg, />90%</u);
      assert.doesNotMatch(svg, /class="(?:meter|ring)-fill"/u);
    } else {
      assert.match(svg, />90%</u);
      assert.doesNotMatch(svg, />Usage blocked</u);
    }
  });
}
