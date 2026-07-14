export type LimitBeaconSettings = {
  basis: "remaining" | "used";
  refreshMinutes: number;
  warningThreshold: number;
  criticalThreshold: number;
  resetStyle: "countdown" | "local-time";
  codexExecutable: string;
};

const DEFAULT_SETTINGS: LimitBeaconSettings = {
  basis: "remaining",
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
  const basis = valueOrDefault(settings, "basis");
  if (basis !== "remaining" && basis !== "used") {
    throw new TypeError('basis must be "remaining" or "used"');
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
    basis,
    refreshMinutes,
    warningThreshold,
    criticalThreshold,
    resetStyle,
    codexExecutable,
  };
}
