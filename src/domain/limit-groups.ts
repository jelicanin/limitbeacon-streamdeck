import { mapRateLimits, UsageValidationError, type UsageSnapshot } from "./usage.js";

export type LimitGroup = {
  id: string;
  label: string;
  snapshot: UsageSnapshot | null;
};

export type UsageCollection = {
  capturedAt: number;
  defaultGroupId: string | null;
  groups: LimitGroup[];
};

export function mapLimitGroups(response: unknown, capturedAt = Date.now()): UsageCollection {
  if (!isRecord(response) || (!isRecord(response.rateLimits) && !isRecord(response.rateLimitsByLimitId))) {
    throw new UsageValidationError("MISSING_PRIMARY_USAGE", "Codex response does not contain rate limits");
  }
  const entries = new Map<string, unknown>();
  if (isRecord(response.rateLimitsByLimitId)) {
    for (const [id, value] of Object.entries(response.rateLimitsByLimitId)) {
      if (validGroupId(id)) entries.set(id, value);
    }
  }
  const legacy = isRecord(response.rateLimits) ? response.rateLimits : null;
  const legacyId = legacy === null ? null : validGroupId(legacy.limitId) ? legacy.limitId : "codex";
  if (legacyId !== null && !entries.has(legacyId)) entries.set(legacyId, legacy);
  const groups = [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, value], index) => {
    const name = isRecord(value) && typeof value.limitName === "string"
      ? value.limitName.replace(/[\u0000-\u001f\u007f]/gu, "").trim().slice(0, 80) : "";
    const label = name && name !== id
      ? name
      : id === "codex" ? "Codex" : `Limit group ${index + 1}`;
    let snapshot: UsageSnapshot | null = null;
    try {
      snapshot = mapRateLimits({ rateLimits: value, rateLimitResetCredits: response.rateLimitResetCredits }, capturedAt);
    } catch (error) {
      if (!(error instanceof UsageValidationError)) throw error;
      if (id === legacyId && legacy !== value) {
        try {
          snapshot = mapRateLimits({ rateLimits: legacy, rateLimitResetCredits: response.rateLimitResetCredits }, capturedAt);
        } catch (legacyError) {
          if (!(legacyError instanceof UsageValidationError)) throw legacyError;
        }
      }
    }
    return { id, label, snapshot };
  });
  const valid = (id: string | null) => groups.find(group => group.id === id && group.snapshot !== null);
  if (!isRecord(response.rateLimitsByLimitId) && groups.every(group => group.snapshot === null)) {
    throw new UsageValidationError("INVALID_RATE_LIMIT_WINDOW", "Codex returned invalid rate limits");
  }
  const preferred = valid("codex") ?? valid(legacyId) ?? groups.find(group => group.snapshot !== null);
  return { capturedAt, groups, defaultGroupId: preferred?.id ?? groups[0]?.id ?? null };
}

export function validGroupId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

export function normalizeGroupSelection(value: unknown): string {
  return validGroupId(value) ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
