export type DailyTokenUsage = {
  startDate: string;
  tokens: number;
};

export type TokenUsageSummary = {
  currentStreakDays: number | null;
  lifetimeTokens: number | null;
  longestRunningTurnSec: number | null;
  longestStreakDays: number | null;
  peakDailyTokens: number | null;
};

export type TokenUsageSnapshot = {
  capturedAt: number;
  daily: DailyTokenUsage[];
  summary: TokenUsageSummary;
  stale: boolean;
};

export class TokenUsageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenUsageValidationError";
  }
}

type UnknownRecord = Record<string, unknown>;

const summaryFields = [
  "currentStreakDays",
  "lifetimeTokens",
  "longestRunningTurnSec",
  "longestStreakDays",
  "peakDailyTokens",
] as const;

export function mapTokenUsage(
  response: unknown,
  capturedAt = Date.now(),
): TokenUsageSnapshot {
  if (!isRecord(response) || !isRecord(response.summary)) {
    throw new TokenUsageValidationError("Codex response does not contain token usage summary");
  }

  const rawSummary = response.summary;
  const buckets = response.dailyUsageBuckets;
  if (buckets !== undefined && buckets !== null && !Array.isArray(buckets)) {
    throw new TokenUsageValidationError("dailyUsageBuckets must be an array or null");
  }

  const summary = Object.fromEntries(
    summaryFields.map((field) => [field, readNullableInteger(rawSummary, field)]),
  ) as TokenUsageSummary;

  const daily = (buckets ?? []).map((bucket) => mapDailyBucket(bucket));
  if (new Set(daily.map((bucket) => bucket.startDate)).size !== daily.length) {
    throw new TokenUsageValidationError("Daily token usage contains duplicate dates");
  }
  daily.sort((left, right) => right.startDate.localeCompare(left.startDate));

  return { capturedAt, daily, summary, stale: false };
}

function mapDailyBucket(value: unknown): DailyTokenUsage {
  if (!isRecord(value) || typeof value.startDate !== "string" || value.startDate.length === 0) {
    throw new TokenUsageValidationError("Daily token usage must include a start date");
  }
  const date = new Date(`${value.startDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value.startDate)
    || !Number.isFinite(date.getTime())
    || date.toISOString().slice(0, 10) !== value.startDate) {
    throw new TokenUsageValidationError("Daily token usage must include a valid YYYY-MM-DD date");
  }
  return {
    startDate: value.startDate,
    tokens: readInteger(value.tokens, "tokens"),
  };
}

function readNullableInteger(record: UnknownRecord, field: string): number | null {
  const value = record[field];
  return value === undefined || value === null ? null : readInteger(value, field);
}

function readInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TokenUsageValidationError(`${field} must be a non-negative integer`);
  }
  return Number(value);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
