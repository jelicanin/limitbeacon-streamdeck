export type DialSettings = {
  activeIndex: number;
  basis: "remaining" | "used";
  displayStyle: "bars" | "rings";
};

export function normalizeDialSettings(raw: unknown): DialSettings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { activeIndex: 0, basis: "remaining", displayStyle: "rings" };
  }
  const value = raw as Record<string, unknown>;
  return {
    activeIndex: Number.isSafeInteger(value.activeIndex) && Number(value.activeIndex) >= 0
      ? Number(value.activeIndex)
      : 0,
    basis: value.basis === "used" ? "used" : "remaining",
    displayStyle: value.displayStyle === "bars" ? "bars" : "rings",
  };
}
