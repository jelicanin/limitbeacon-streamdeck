export type UsageWindow = {
  usedPercent: number;
  remainingPercent: number;
  durationMinutes: number | null;
  resetsAt: number | null;
};

export type AccountHealth = {
  credits: {
    hasCredits: boolean;
    unlimited: boolean;
    balance: string | null;
  } | null;
  individualLimit: {
    limit: string;
    used: string;
    remainingPercent: number;
    resetsAt: number;
  } | null;
  spendControlReached: boolean | null;
  rateLimitReachedType: string | null;
  resetCreditsAvailable: number | null;
};

export type UsageSnapshot = {
  capturedAt: number;
  fiveHour: UsageWindow;
  weekly: UsageWindow | null;
  planLabel: string | null;
  accountHealth: AccountHealth;
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
    accountHealth: mapAccountHealth(rateLimits, response),
    stale: false,
  };
}

function mapAccountHealth(rateLimits: UnknownRecord, response: UnknownRecord): AccountHealth {
  const credits = rateLimits.credits;
  const individualLimit = rateLimits.individualLimit;
  const resetCredits = response.rateLimitResetCredits;

  return {
    credits:
      credits === undefined || credits === null
        ? null
        : mapCredits(credits),
    individualLimit:
      individualLimit === undefined || individualLimit === null
        ? null
        : mapIndividualLimit(individualLimit),
    spendControlReached: readNullableBoolean(rateLimits, "spendControlReached"),
    rateLimitReachedType: readNullableString(rateLimits, "rateLimitReachedType"),
    resetCreditsAvailable:
      resetCredits === undefined || resetCredits === null
        ? null
        : mapResetCreditCount(resetCredits),
  };
}

function mapCredits(value: unknown): NonNullable<AccountHealth["credits"]> {
  if (!isRecord(value) || typeof value.hasCredits !== "boolean" || typeof value.unlimited !== "boolean") {
    throw new UsageValidationError("INVALID_RATE_LIMIT_WINDOW", "credits is invalid");
  }
  const balance = value.balance;
  if (balance !== undefined && balance !== null && typeof balance !== "string") {
    throw new UsageValidationError("INVALID_RATE_LIMIT_WINDOW", "credit balance is invalid");
  }
  return { hasCredits: value.hasCredits, unlimited: value.unlimited, balance: balance ?? null };
}

function mapIndividualLimit(value: unknown): NonNullable<AccountHealth["individualLimit"]> {
  if (!isRecord(value) || typeof value.limit !== "string" || typeof value.used !== "string") {
    throw new UsageValidationError("INVALID_RATE_LIMIT_WINDOW", "individual limit is invalid");
  }
  return {
    limit: value.limit,
    used: value.used,
    remainingPercent: readPercentage(value.remainingPercent),
    resetsAt: readRequiredNonNegativeNumber(value, "resetsAt"),
  };
}

function mapResetCreditCount(value: unknown): number {
  if (!isRecord(value) || !Number.isSafeInteger(value.availableCount) || Number(value.availableCount) < 0) {
    throw new UsageValidationError("INVALID_RATE_LIMIT_WINDOW", "reset credit count is invalid");
  }
  return Number(value.availableCount);
}

function readRequiredNonNegativeNumber(record: UnknownRecord, field: string): number {
  const value = readNullableNonNegativeNumber(record, field);
  if (value === null) {
    throw new UsageValidationError("INVALID_RATE_LIMIT_WINDOW", `${field} is required`);
  }
  return value;
}

function readNullableBoolean(record: UnknownRecord, field: string): boolean | null {
  const value = record[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") {
    throw new UsageValidationError("INVALID_RATE_LIMIT_WINDOW", `${field} must be a boolean or null`);
  }
  return value;
}

function readNullableString(record: UnknownRecord, field: string): string | null {
  const value = record[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new UsageValidationError("INVALID_RATE_LIMIT_WINDOW", `${field} must be a string or null`);
  }
  return value;
}
