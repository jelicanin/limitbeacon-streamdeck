import {
  selectUsageGroup,
  type UsageServiceState,
} from "../services/usage-service.js";
import type { NeoSettings } from "../domain/neo-settings.js";
import { inspectorConnectionPayload } from "../ui/inspector-connection.js";

/** Render one display-only quota window; never replace an explicit missing selection. */
export function renderNeo(
  raw: UsageServiceState,
  settings: NeoSettings,
  now = Date.now(),
): string {
  const state = selectUsageGroup(raw, settings.limitGroupId);
  if (state.groupUnavailable)
    return message("Group unavailable", "Choose a group in settings");
  if (state.snapshot?.accountHealth.ordinaryUsageAllowed === false) {
    return message("Usage blocked", "Check Codex");
  }
  if (state.snapshot === null) {
    const status = inspectorConnectionPayload(state).status;
    const title =
      status === "starting"
        ? "Codex is starting"
        : status === "codex-missing"
          ? "Install Codex"
          : status === "sign-in-required"
            ? "Sign in to Codex"
            : status === "incompatible"
              ? "Update Codex connection"
              : "Could not refresh";
    return message(title, "Open LimitBeacon settings");
  }
  const window =
    settings.window === "secondary"
      ? state.snapshot.weekly
      : settings.window === "primary"
        ? state.snapshot.fiveHour
        : (state.snapshot.fiveHour ?? state.snapshot.weekly);
  if (window === null)
    return message("Window unavailable", "Choose a window in settings");
  const remaining = window.remainingPercent;
  const color =
    remaining <= 15 ? "#FF6B6B" : remaining <= 35 ? "#F2B84B" : "#55C7E8";
  const minutes = window.durationMinutes;
  const duration =
    minutes === null
      ? "LIMIT"
      : minutes % 1440 === 0
        ? `${minutes / 1440}D`
        : minutes % 60 === 0
          ? `${minutes / 60}H`
          : `${minutes}M`;
  const reset =
    window.resetsAt === null
      ? "RESET unavailable"
      : `RESET ${countdown(window.resetsAt, now)}`;
  return canvas(`
    <text x="8" y="13" font-size="10" fill="#ADC5D8">${escapeXml(shorten(state.groupLabel ?? "Codex", 16))}</text>
    <text x="8" y="30" font-size="12" fill="#E9F3F8">${escapeXml(shorten(duration, 12))} LEFT</text>
    <text x="8" y="44" font-size="10" fill="#ADC5D8">${escapeXml(shorten(reset, 23))}</text>
    <text x="224" y="33" text-anchor="end" font-size="23" font-weight="700" fill="${color}">${Math.round(remaining)}%</text>
    ${state.snapshot.stale || state.status === "stale" ? '<text x="224" y="12" text-anchor="end" font-size="9" fill="#F2B84B">STALE</text>' : ""}
  `);
}

function message(title: string, detail: string): string {
  return canvas(`<text x="8" y="21" font-size="13" fill="#E9F3F8">${escapeXml(title)}</text>
    <text x="8" y="39" font-size="10" fill="#ADC5D8">${escapeXml(detail)}</text>`);
}

function canvas(content: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="232" height="50" viewBox="0 0 232 50">
    <rect width="232" height="50" fill="#071827"/>
    <g font-family="Arial, sans-serif">${content}</g></svg>`;
}

function countdown(resetsAt: number, now: number): string {
  const minutes = Math.max(0, Math.ceil((resetsAt * 1000 - now) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24
    ? `${hours}h ${minutes % 60}m`
    : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function shorten(value: string, length: number): string {
  const chars = [...value];
  return chars.length > length
    ? chars.slice(0, length - 1).join("") + "…"
    : value;
}

function escapeXml(value: string): string {
  const entities: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  };
  return value.replace(/[&<>"']/gu, (c) => entities[c]!);
}
