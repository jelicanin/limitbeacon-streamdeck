import { normalizeGroupSelection } from "./limit-groups.js";

export type LimitBeaconSettings = {
  appearance?: Appearance;
  limitGroupId: string;
  window: "automatic" | "primary" | "secondary";
  basis: "remaining" | "used";
  displayStyle: "bars" | "rings";
  refreshMinutes: number;
  warningThreshold: number;
  criticalThreshold: number;
  resetStyle: "countdown" | "local-time";
  codexExecutable: string;
};

export type Appearance = {
  background: string;
  text: string | null;
  healthy: string;
  outline: boolean;
  outlineColor: string;
};

export const DEFAULT_APPEARANCE: Appearance = {
  background: "#071827", text: null, healthy: "#55C7E8", outline: false, outlineColor: "#55C7E8",
};

export function validHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/iu.test(value);
}

export function normalizeAppearance(raw: unknown): Appearance {
  const value = typeof raw === "object" && raw !== null && !Array.isArray(raw)
    ? raw as Record<string, unknown> : {};
  return {
    background: validHexColor(value.background) ? value.background.toUpperCase() : DEFAULT_APPEARANCE.background,
    text: validHexColor(value.text) ? value.text.toUpperCase() : null,
    healthy: validHexColor(value.healthy) ? value.healthy.toUpperCase() : DEFAULT_APPEARANCE.healthy,
    outline: value.outline === true,
    outlineColor: validHexColor(value.outlineColor) ? value.outlineColor.toUpperCase() : DEFAULT_APPEARANCE.outlineColor,
  };
}

const DEFAULT_SETTINGS: LimitBeaconSettings = {
  limitGroupId: "",
  window: "automatic",
  basis: "remaining",
  displayStyle: "bars",
  refreshMinutes: 5,
  warningThreshold: 35,
  criticalThreshold: 15,
  resetStyle: "countdown",
  codexExecutable: "",
};

type UnknownSettings = Record<string, unknown>;

function valueOrDefault(
  settings: UnknownSettings,
  field: keyof LimitBeaconSettings,
): unknown {
  return Object.hasOwn(settings, field) ? settings[field] : DEFAULT_SETTINGS[field];
}

function readPercentage(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new RangeError(`${field} must be a finite number between 0 and 100`);
  }
  return value;
}

export function normalizeSettings(raw: unknown): LimitBeaconSettings {
  if (raw === undefined || raw === null) {
    return { ...DEFAULT_SETTINGS };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("settings must be an object");
  }

  const settings = raw as UnknownSettings;
  const window = valueOrDefault(settings, "window");
  if (window !== "automatic" && window !== "primary" && window !== "secondary") {
    throw new TypeError('window must be "automatic", "primary", or "secondary"');
  }

  const basis = valueOrDefault(settings, "basis");
  if (basis !== "remaining" && basis !== "used") {
    throw new TypeError('basis must be "remaining" or "used"');
  }

  const displayStyle = valueOrDefault(settings, "displayStyle");
  if (displayStyle !== "bars" && displayStyle !== "rings") {
    throw new TypeError('displayStyle must be "bars" or "rings"');
  }

  const refreshMinutes = valueOrDefault(settings, "refreshMinutes");
  if (
    typeof refreshMinutes !== "number" ||
    !Number.isInteger(refreshMinutes) ||
    refreshMinutes < 1 ||
    refreshMinutes > 60
  ) {
    throw new RangeError("refreshMinutes must be an integer between 1 and 60");
  }

  const warningThreshold = readPercentage(
    valueOrDefault(settings, "warningThreshold"),
    "warningThreshold",
  );
  const criticalThreshold = readPercentage(
    valueOrDefault(settings, "criticalThreshold"),
    "criticalThreshold",
  );
  if (criticalThreshold > warningThreshold) {
    throw new RangeError(
      "criticalThreshold must be less than or equal to warningThreshold",
    );
  }

  const resetStyle = valueOrDefault(settings, "resetStyle");
  if (resetStyle !== "countdown" && resetStyle !== "local-time") {
    throw new TypeError('resetStyle must be "countdown" or "local-time"');
  }

  const codexExecutable = valueOrDefault(settings, "codexExecutable");
  if (typeof codexExecutable !== "string") {
    throw new TypeError("codexExecutable must be a string");
  }

  return {
    ...(Object.hasOwn(settings, "appearance") ? { appearance: normalizeAppearance(settings.appearance) } : {}),
    limitGroupId: normalizeGroupSelection(settings.limitGroupId),
    window,
    basis,
    displayStyle,
    refreshMinutes,
    warningThreshold,
    criticalThreshold,
    resetStyle,
    codexExecutable,
  };
}
