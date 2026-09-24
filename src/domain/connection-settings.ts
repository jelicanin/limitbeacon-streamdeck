import { normalizeSettings, type LimitBeaconSettings } from "./settings.js";

export type ConnectionSettings = Pick<LimitBeaconSettings, "refreshMinutes" | "codexExecutable">;

export function readConnectionSettings(
  raw: unknown,
  previous: ConnectionSettings,
): { settings: ConnectionSettings; valid: boolean } {
  try {
    if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
      return { settings: previous, valid: false };
    }
    const input: Record<string, unknown> = {};
    for (const field of ["refreshMinutes", "codexExecutable"] as const) {
      if (raw != null && Object.hasOwn(raw, field)) {
        input[field] = (raw as Record<string, unknown>)[field];
      }
    }
    const settings = normalizeSettings(input);
    return {
      settings: { refreshMinutes: settings.refreshMinutes, codexExecutable: settings.codexExecutable },
      valid: true,
    };
  } catch {
    return { settings: previous, valid: false };
  }
}
