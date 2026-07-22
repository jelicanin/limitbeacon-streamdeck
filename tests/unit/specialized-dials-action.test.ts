import assert from "node:assert/strict";
import test from "node:test";

import {
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
  assert.deepEqual(summary.map((card) => card.label), ["7D TOTAL", "DAILY AVG", "PEAK DAY"]);
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
  assert.deepEqual(buildDailyCards(snapshot, true).map((card) => card.label), ["7D TOTAL", "DAILY AVG"]);
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

  assert.match(latestSvg(daily), />7D TOTAL</u);
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
