export type UsageWindow = {
  usedPercent: number;
  remainingPercent: number;
  durationMinutes: number | null;
  resetsAt: number | null;
};

export type UsageSnapshot = {
  capturedAt: number;
  fiveHour: UsageWindow;
  weekly: UsageWindow | null;
  planLabel: string | null;
  stale: boolean;
};

export type UsageErrorCode =
  | "MISSING_PRIMARY_USAGE"
  | "INVALID_USAGE_PERCENT"
  | "INVALID_RATE_LIMIT_WINDOW";

export class UsageValidationError extends Error {
  readonly code: UsageErrorCode;

  constructor(code: UsageErrorCode, message: string) {
    super(message);
    this.name = "UsageValidationError";
    this.code = code;
  }
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPercentage(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new UsageValidationError(
      "INVALID_USAGE_PERCENT",
      "Rate-limit usage percentage must be a finite number between 0 and 100",
    );
  }
  return value;
}

function readNullableNonNegativeNumber(window: UnknownRecord, field: string): number | null {
  const value = window[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new UsageValidationError(
      "INVALID_RATE_LIMIT_WINDOW",
      `${field} must be a non-negative finite number or null`,
    );
  }
  return value;
}

function mapWindow(value: unknown, label: string): UsageWindow {
  if (!isRecord(value)) {
    throw new UsageValidationError(
      "INVALID_RATE_LIMIT_WINDOW",
      `${label} rate-limit window must be an object`,
    );
  }

  const usedPercent = readPercentage(value.usedPercent);
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    durationMinutes: readNullableNonNegativeNumber(value, "windowDurationMins"),
    resetsAt: readNullableNonNegativeNumber(value, "resetsAt"),
  };
}

export function mapRateLimits(response: unknown, capturedAt = Date.now()): UsageSnapshot {
  if (!isRecord(response) || !isRecord(response.rateLimits)) {
    throw new UsageValidationError(
      "MISSING_PRIMARY_USAGE",
      "Codex response does not contain rate limits",
    );
  }

  const rateLimits = response.rateLimits;
  if (!isRecord(rateLimits.primary)) {
    throw new UsageValidationError(
      "MISSING_PRIMARY_USAGE",
      "Codex response does not contain a primary rate-limit window",
    );
  }

  const secondary = rateLimits.secondary;
  return {
    capturedAt,
    fiveHour: mapWindow(rateLimits.primary, "five-hour"),
    weekly:
      secondary === undefined || secondary === null ? null : mapWindow(secondary, "weekly"),
    planLabel: typeof rateLimits.planType === "string" ? rateLimits.planType : null,
    stale: false,
  };
}
