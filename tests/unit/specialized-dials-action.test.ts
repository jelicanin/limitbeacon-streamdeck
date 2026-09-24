import assert from "node:assert/strict";
import test from "node:test";

import {
  ActivityStatsAction,
  CreditsSpendAction,
  DailyTokensAction,
  buildActivityCards,
  buildCreditsCards,
  buildDailyCards,
  SpecializedDialController,
} from "../../src/actions/specialized-dials-action.js";
import type { TokenUsageSnapshot } from "../../src/domain/token-usage.js";
import type { UsageSnapshot } from "../../src/domain/usage.js";
import type {
  TokenUsageServiceState,
  TokenUsageSubscriber,
  UsageServiceState,
  UsageSubscriber,
} from "../../src/services/usage-service.js";

const tokenSnapshot: TokenUsageSnapshot = {
  capturedAt: 1,
  daily: [
    { startDate: "2026-07-22", tokens: 700_000 },
    { startDate: "2026-07-21", tokens: 400_000 },
    { startDate: "2026-07-20", tokens: 100_000 },
  ],
  summary: {
    currentStreakDays: 3,
    lifetimeTokens: 123_500_000,
    longestRunningTurnSec: 905,
    longestStreakDays: 8,
    peakDailyTokens: 2_400_000,
  },
  stale: false,
};

const usageSnapshot: UsageSnapshot = {
  capturedAt: 1,
  fiveHour: { usedPercent: 20, remainingPercent: 80, durationMinutes: 300, resetsAt: null },
  weekly: null,
  planLabel: "plus",
  accountHealth: {
    credits: { hasCredits: true, unlimited: false, balance: "12.50" },
    individualLimit: { limit: "100", used: "40", remainingPercent: 60, resetsAt: 1_800_000_000 },
    spendControlReached: false,
    rateLimitReachedType: null,
    resetCreditsAvailable: 2,
  },
  stale: false,
};

test("daily cards use returned buckets and derive only the visible seven-day summaries", () => {
  const daily = buildDailyCards(tokenSnapshot, false, new Date(2026, 6, 22));
  const summary = buildDailyCards(tokenSnapshot, true, new Date(2026, 6, 22));

  assert.equal(daily.length, 3);
  assert.deepEqual(daily.map((card) => card.kind === "daily" ? card.value : null), ["700K", "400K", "100K"]);
  assert.equal(daily[0]?.kind === "daily" ? daily[0].label : null, "TODAY");
  assert.deepEqual(summary.map((card) => card.label), ["REPORTED TOTAL", "REPORTED AVG", "ACCOUNT PEAK"]);
  assert.deepEqual(summary.map((card) => card.value), ["1.2M", "400K", "2.4M"]);
});

test("daily card dates include the localized two-digit year", () => {
  const cards = buildDailyCards(tokenSnapshot, false, new Date(2026, 6, 22));
  const previousDay = cards[1];

  assert.equal(previousDay?.kind, "daily");
  assert.match(previousDay?.kind === "daily" ? previousDay.detail : "", /26/u);
});

test("daily summary does not invent a peak when Codex omits it", () => {
  const snapshot = { ...tokenSnapshot, summary: { ...tokenSnapshot.summary, peakDailyTokens: null } };
  assert.deepEqual(buildDailyCards(snapshot, true).map((card) => card.label), ["REPORTED TOTAL", "REPORTED AVG"]);
});

test("credits cards include only account data supplied by Codex", () => {
  const cards = buildCreditsCards(usageSnapshot);

  assert.deepEqual(cards.map((card) => card.label), ["CREDIT BALANCE", "SPEND LEFT", "RESET CREDITS"]);
  assert.deepEqual(cards.map((card) => card.value), ["12.50", "60%", "2"]);
  assert.deepEqual(buildCreditsCards({
    ...usageSnapshot,
    accountHealth: {
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      rateLimitReachedType: null,
      resetCreditsAvailable: null,
    },
  }), []);
});

test("activity cards omit unavailable statistics", () => {
  const cards = buildActivityCards({
    ...tokenSnapshot,
    summary: { ...tokenSnapshot.summary, currentStreakDays: null, longestStreakDays: null },
  });

  assert.deepEqual(cards.map((card) => card.label), ["LIFETIME TOKENS", "PEAK DAY", "LONGEST TURN"]);
  assert.deepEqual(cards.map((card) => card.value), ["123.5M", "2.4M", "15m 5s"]);
});

test("long activity durations stay compact enough for the dial", () => {
  const cards = buildActivityCards({
    ...tokenSnapshot,
    summary: {
      ...tokenSnapshot.summary,
      lifetimeTokens: null,
      peakDailyTokens: null,
      currentStreakDays: null,
      longestStreakDays: null,
      longestRunningTurnSec: 771_653,
    },
  });

  assert.deepEqual(cards.map((card) => card.value), ["8d 22h"]);
});

class FakeService {
  rateState: UsageServiceState = { status: "ready", snapshot: usageSnapshot, error: null };
  tokenState: TokenUsageServiceState = { status: "ready", snapshot: tokenSnapshot, error: null };
  rateSubscribers = new Set<UsageSubscriber>();
  tokenSubscribers = new Set<TokenUsageSubscriber>();
  rateRefreshCount = 0;
  tokenRefreshCount = 0;

  subscribe(subscriber: UsageSubscriber): () => void {
    this.rateSubscribers.add(subscriber);
    subscriber(this.rateState);
    return () => this.rateSubscribers.delete(subscriber);
  }

  subscribeTokenUsage(subscriber: TokenUsageSubscriber): () => void {
    this.tokenSubscribers.add(subscriber);
    subscriber(this.tokenState);
    return () => this.tokenSubscribers.delete(subscriber);
  }

  async refresh(): Promise<UsageServiceState> {
    this.rateRefreshCount += 1;
    return this.rateState;
  }

  async refreshTokenUsage(): Promise<TokenUsageServiceState> {
    this.tokenRefreshCount += 1;
    return this.tokenState;
  }
}

class FakeDial {
  feedback: Array<Record<string, unknown>> = [];
  settings: Array<Record<string, unknown>> = [];
  alertCount = 0;

  constructor(readonly id: string) {}

  async setFeedback(value: Record<string, unknown>): Promise<void> {
    this.feedback.push(value);
  }

  async setSettings(value: Record<string, unknown>): Promise<void> {
    this.settings.push(value);
  }

  async showAlert(): Promise<void> {
    this.alertCount += 1;
  }
}

function latestSvg(dial: FakeDial): string {
  const canvas = dial.feedback.at(-1)?.canvas;
  assert.equal(typeof canvas, "string");
  return decodeURIComponent((canvas as string).slice("data:image/svg+xml,".length));
}

test("each specialized dial subscribes only to its required shared data channel", () => {
  const service = new FakeService();
  const daily = new SpecializedDialController(service, "daily");
  const credits = new SpecializedDialController(service, "credits");
  const activity = new SpecializedDialController(service, "activity");

  daily.appear(new FakeDial("daily"), {});
  credits.appear(new FakeDial("credits"), {});
  activity.appear(new FakeDial("activity"), {});

  assert.equal(service.tokenSubscribers.size, 2);
  assert.equal(service.rateSubscribers.size, 1);
});

test("rotation remains local to one specialized dial", async () => {
  const service = new FakeService();
  const controller = new SpecializedDialController(service, "activity");
  const first = new FakeDial("first");
  const second = new FakeDial("second");
  controller.appear(first, {});
  controller.appear(second, {});

  await controller.rotate(first.id, 1);

  assert.match(latestSvg(first), />PEAK DAY</u);
  assert.match(latestSvg(second), />LIFETIME TOKENS</u);
  assert.deepEqual(first.settings.at(-1), { activeIndex: 1, summary: false });
});

test("touch toggles daily detail and summary but is inert for other specialized dials", async () => {
  const service = new FakeService();
  const dailyController = new SpecializedDialController(service, "daily");
  const creditsController = new SpecializedDialController(service, "credits");
  const daily = new FakeDial("daily");
  const credits = new FakeDial("credits");
  dailyController.appear(daily, {});
  creditsController.appear(credits, {});

  await dailyController.touch(daily.id);
  await creditsController.touch(credits.id);

  assert.match(latestSvg(daily), />REPORTED TOTAL</u);
  assert.deepEqual(daily.settings.at(-1), { activeIndex: 0, summary: true });
  assert.equal(credits.settings.length, 0);
});

test("press refreshes the channel used by each specialized dial", async () => {
  const service = new FakeService();
  const dailyController = new SpecializedDialController(service, "daily");
  const creditsController = new SpecializedDialController(service, "credits");
  const daily = new FakeDial("daily");
  const credits = new FakeDial("credits");
  dailyController.appear(daily, {});
  creditsController.appear(credits, {});

  await dailyController.press(daily.id);
  await creditsController.press(credits.id);

  assert.equal(service.tokenRefreshCount, 1);
  assert.equal(service.rateRefreshCount, 1);
  assert.equal(daily.alertCount + credits.alertCount, 0);
});

test("daily details and summaries share the latest seven calendar dates", () => {
  const snapshot = { ...tokenSnapshot, daily: [
    { startDate: "2026-07-14", tokens: 9_000 },
    ...Array.from({ length: 8 }, (_, index) => ({ startDate: `2026-07-${22 - index}`, tokens: 100 })),
  ] };
  const detail = buildDailyCards(snapshot, false);
  const summary = buildDailyCards(snapshot, true);
  assert.equal(detail.length, 7);
  assert.deepEqual(detail.map((card) => card.value), ["100", "100", "100", "100", "100", "100", "100"]);
  assert.equal(summary[0]?.label, "7D TOTAL");
  assert.equal(summary[0]?.value, "700");
  assert.equal(summary[1]?.value, "100");
});

test("gapped daily coverage neither spans older dates nor invents zero days", () => {
  const snapshot = { ...tokenSnapshot, daily: [
    { startDate: "2026-07-22", tokens: 600 },
    { startDate: "2026-07-20", tokens: 200 },
    { startDate: "2026-07-16", tokens: 100 },
    { startDate: "2026-07-15", tokens: 9_000 },
  ] };
  const detail = buildDailyCards(snapshot, false);
  const summary = buildDailyCards(snapshot, true);
  assert.equal(detail.length, 3);
  assert.deepEqual(detail.map((card) => card.kind === "daily" ? card.bars : null), [[17, 33, 100], [17, 33, 100], [17, 33, 100]]);
  assert.deepEqual(summary.slice(0, 2).map((card) => [card.label, card.value, card.detail]), [["REPORTED TOTAL", "900", "3 OF 7 DAYS"], ["REPORTED AVG", "300", "3 OF 7 DAYS"]]);
});

for (const interrupt of ["disappear", "touch", "settings", "state", "press"] as const) {
  test(`specialized animation stops after ${interrupt} supersedes it`, async () => {
    const service = new FakeService();
    const controller = new SpecializedDialController(service, "daily");
    const dial = new FakeDial("cancel");
    controller.appear(dial, {});
    let releaseFrame!: () => void;
    const setFeedback = dial.setFeedback.bind(dial);
    let block = true;
    dial.setFeedback = async (feedback) => {
      await setFeedback(feedback);
      if (block) {
        block = false;
        await new Promise<void>((resolve) => { releaseFrame = resolve; });
      }
    };
    const rotation = controller.rotate(dial.id, 1);
    while (releaseFrame === undefined) await Promise.resolve();
    if (interrupt === "disappear") controller.disappear(dial.id);
    if (interrupt === "touch") await controller.touch(dial.id);
    if (interrupt === "settings") controller.settingsChanged(dial.id, { summary: true });
    if (interrupt === "state") for (const subscriber of service.tokenSubscribers) subscriber({ status: "error", snapshot: null, error: new Error("unavailable") });
    if (interrupt === "press") await controller.press(dial.id);
    const latest = latestSvg(dial);
    const count = dial.feedback.length;
    releaseFrame();
    await rotation;
    assert.equal(dial.feedback.length, count, "obsolete animation must not send another frame");
    assert.equal(latestSvg(dial), latest);
  });
}

for (const kind of ["daily", "credits", "activity"] as const) {
  test(`${kind} inspector follows its own data channel and unsubscribes`, () => {
    const service = new FakeService();
    service.rateState = { status: "loading", snapshot: null, error: null };
    const controller = new SpecializedDialController(service, kind);
    const messages: unknown[] = [];
    controller.inspectorAppeared("inspector", async (payload) => { messages.push(payload); });
    assert.deepEqual(messages, [{ status: kind === "credits" ? "starting" : "connected" }]);
    controller.inspectorDisappeared("inspector");
    for (const subscriber of service.rateSubscribers) subscriber(service.rateState);
    for (const subscriber of service.tokenSubscribers) subscriber(service.tokenState);
    assert.equal(messages.length, 1);
  });
}


for (const [kind, Action] of [["daily", DailyTokensAction], ["credits", CreditsSpendAction], ["activity", ActivityStatsAction]] as const) {
  test(`${kind} inspector Retry refreshes only its own channel`, async () => {
    const service = new FakeService();
    const controller = new SpecializedDialController(service, kind);
    controller.appear(new FakeDial("retry"), {});
    const action = new Action(controller);
    for (const command of ["ignored", "refresh"]) {
      await action.onSendToPlugin({ type: "sendToPlugin", action: { id: "retry" }, payload: { command } } as unknown as Parameters<DailyTokensAction["onSendToPlugin"]>[0]);
    }
    assert.equal(service.rateRefreshCount, kind === "credits" ? 1 : 0);
    assert.equal(service.tokenRefreshCount, kind === "credits" ? 0 : 1);
  });
}


for (const interrupt of ["disappear", "settings"] as const) {
  test(`specialized render failure cannot alert after ${interrupt}`, async () => {
    const service = new FakeService();
    const controller = new SpecializedDialController(service, "daily");
    const dial = new FakeDial("late-error");
    let rejectFeedback!: (error: Error) => void;
    dial.setFeedback = () => new Promise<void>((_resolve, reject) => { rejectFeedback = reject; });
    controller.appear(dial, {});
    const rejectOldRender = rejectFeedback;
    dial.setFeedback = async () => {};
    if (interrupt === "disappear") controller.disappear(dial.id);
    else controller.settingsChanged(dial.id, {});
    rejectOldRender(new Error("closed connection"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(dial.alertCount, 0);
  });
}

test("specialized render alert failure does not create an unhandled rejection", async () => {
  const service = new FakeService();
  const controller = new SpecializedDialController(service, "daily");
  const dial = new FakeDial("failed-alert");
  dial.setFeedback = async () => { throw new Error("feedback unavailable"); };
  dial.showAlert = async () => {
    dial.alertCount += 1;
    throw new Error("alert unavailable");
  };
  controller.appear(dial, {});
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(dial.alertCount, 1);
  controller.disappear(dial.id);
});
