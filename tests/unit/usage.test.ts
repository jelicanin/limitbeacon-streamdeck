import assert from "node:assert/strict";
import test from "node:test";

import {
  mapRateLimits,
  UsageValidationError,
  type UsageErrorCode,
} from "../../src/domain/usage.js";

const capturedAt = 1_750_000_000_000;

function primary(usedPercent: unknown, overrides: Record<string, unknown> = {}) {
  return {
    usedPercent,
    windowDurationMins: 300,
    resetsAt: 1_750_000_300,
    ...overrides,
  };
}

function assertUsageError(response: unknown, code: UsageErrorCode): void {
  assert.throws(
    () => mapRateLimits(response, capturedAt),
    (error: unknown) => error instanceof UsageValidationError && error.code === code,
  );
}

test("maps valid five-hour and weekly windows", () => {
  const snapshot = mapRateLimits(
    {
      rateLimits: {
        primary: primary(25),
        secondary: {
          usedPercent: 60,
          windowDurationMins: 10_080,
          resetsAt: 1_750_604_800,
        },
        planType: "plus",
      },
    },
    capturedAt,
  );

  assert.deepEqual(snapshot, {
    capturedAt,
    fiveHour: {
      usedPercent: 25,
      remainingPercent: 75,
      durationMinutes: 300,
      resetsAt: 1_750_000_300,
    },
    weekly: {
      usedPercent: 60,
      remainingPercent: 40,
      durationMinutes: 10_080,
      resetsAt: 1_750_604_800,
    },
    planLabel: "plus",
    stale: false,
  });
});

test("does not invent a weekly window", () => {
  const snapshot = mapRateLimits({ rateLimits: { primary: primary(25) } }, capturedAt);

  assert.equal(snapshot.weekly, null);
  assert.equal(snapshot.fiveHour.usedPercent, 25);
});

test("preserves absent reset and duration values as null", () => {
  const snapshot = mapRateLimits(
    { rateLimits: { primary: { usedPercent: 10 } } },
    capturedAt,
  );

  assert.equal(snapshot.fiveHour.resetsAt, null);
  assert.equal(snapshot.fiveHour.durationMinutes, null);
  assert.notEqual(snapshot.fiveHour.resetsAt, capturedAt);
});

test("computes remaining percentage from used percentage", () => {
  const snapshot = mapRateLimits({ rateLimits: { primary: primary(33.3) } }, capturedAt);

  assert.equal(snapshot.fiveHour.remainingPercent, 100 - 33.3);
});

for (const [name, response] of [
  ["missing response", undefined],
  ["missing rate limits", {}],
  ["missing primary window", { rateLimits: {} }],
  ["null primary window", { rateLimits: { primary: null } }],
] as const) {
  test(`rejects ${name}`, () => {
    assertUsageError(response, "MISSING_PRIMARY_USAGE");
  });
}

for (const value of ["25", "NaN", Number.NaN, Number.POSITIVE_INFINITY, -1, 100.01]) {
  test(`rejects invalid primary usage percentage ${String(value)}`, () => {
    assertUsageError(
      { rateLimits: { primary: primary(value) } },
      "INVALID_USAGE_PERCENT",
    );
  });
}

test("rejects an invalid weekly percentage instead of hiding it", () => {
  assertUsageError(
    { rateLimits: { primary: primary(10), secondary: primary(101) } },
    "INVALID_USAGE_PERCENT",
  );
});

for (const [field, value] of [
  ["windowDurationMins", -1],
  ["windowDurationMins", "300"],
  ["resetsAt", -1],
  ["resetsAt", "soon"],
] as const) {
  test(`rejects invalid ${field}`, () => {
    assertUsageError(
      { rateLimits: { primary: primary(10, { [field]: value }) } },
      "INVALID_RATE_LIMIT_WINDOW",
    );
  });
}
