import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

import {
  mapTokenUsage,
  TokenUsageValidationError,
} from "../../src/domain/token-usage.js";

const fixtures = new URL("../fixtures/token-usage/", import.meta.url);
const capturedAt = 1_753_200_000_000;

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(name, fixtures), "utf8"));
}

test("maps summary metrics and sorts daily buckets newest first", async () => {
  const snapshot = mapTokenUsage(await fixture("full.json"), capturedAt);

  assert.equal(snapshot.capturedAt, capturedAt);
  assert.deepEqual(snapshot.daily.map(({ startDate, tokens }) => ({ startDate, tokens })), [
    { startDate: "2026-07-22", tokens: 500_000 },
    { startDate: "2026-07-21", tokens: 400_000 },
    { startDate: "2026-07-20", tokens: 300_000 },
  ]);
  assert.deepEqual(snapshot.summary, {
    currentStreakDays: 4,
    lifetimeTokens: 123_456_789,
    longestRunningTurnSec: 905,
    longestStreakDays: 12,
    peakDailyTokens: 3_456_789,
  });
  assert.equal(snapshot.stale, false);
});

test("preserves unavailable optional token data", async () => {
  const snapshot = mapTokenUsage(await fixture("partial.json"), capturedAt);

  assert.deepEqual(snapshot.daily, []);
  assert.deepEqual(snapshot.summary, {
    currentStreakDays: null,
    lifetimeTokens: null,
    longestRunningTurnSec: null,
    longestStreakDays: null,
    peakDailyTokens: null,
  });
});

for (const [name, response] of [
  ["missing summary", {}],
  ["invalid daily buckets", { summary: {}, dailyUsageBuckets: {} }],
  ["invalid token count", { summary: {}, dailyUsageBuckets: [{ startDate: "2026-07-22", tokens: -1 }] }],
  ["invalid summary metric", { summary: { lifetimeTokens: "many" }, dailyUsageBuckets: [] }],
] as const) {
  test(`rejects ${name}`, () => {
    assert.throws(() => mapTokenUsage(response, capturedAt), TokenUsageValidationError);
  });
}
