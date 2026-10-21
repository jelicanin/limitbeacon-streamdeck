import { normalizeGroupSelection } from "./limit-groups.js";

export type NeoSettings = {
  limitGroupId: string;
  window: "automatic" | "primary" | "secondary";
};
export function normalizeNeoSettings(raw: unknown): NeoSettings {
  const value =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  return {
    limitGroupId: normalizeGroupSelection(value.limitGroupId),
    window:
      value.window === "primary" || value.window === "secondary"
        ? value.window
        : "automatic",
  };
}
