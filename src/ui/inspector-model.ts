export type InspectorStatusId =
  | "connected"
  | "group-unavailable"
  | "codex-missing"
  | "sign-in-required"
  | "starting"
  | "stale"
  | "incompatible"
  | "error";

export type InspectorStatusModel = {
  title: string;
  detail: string;
  action:
    | { kind: "button"; label: string; command: "refresh"; disabled?: boolean }
    | { kind: "link"; label: string; href: string };
};

export type StaleReason = "invalid-data" | "codex-missing" | "sign-in-required" | "incompatible" | "timeout" | "refresh-failed";

const staleDetails: Record<StaleReason, string> = {
  "invalid-data": "The selected group returned unusable data. The last good values remain visible.",
  "codex-missing": "Codex could not be found. Check its path and retry; the last good values remain visible.",
  "sign-in-required": "Codex requires sign-in. The last good values remain visible.",
  incompatible: "Codex returned an unsupported response. The last good values remain visible.",
  timeout: "The Codex request timed out. The last good values remain visible.",
  "refresh-failed": "The refresh failed. Check Codex and retry; the last good values remain visible.",
};

export function staleDetail(value: unknown): string | undefined {
  return typeof value === "string" && Object.hasOwn(staleDetails, value)
    ? staleDetails[value as StaleReason] : undefined;
}

const models: Record<InspectorStatusId, InspectorStatusModel> = {
  "group-unavailable": {
    title: "Group unavailable",
    detail: "The selected limit group is unavailable. Choose another group or retry; your selection is saved.",
    action: { kind: "button", label: "Retry", command: "refresh" },
  },
  connected: {
    title: "Connected",
    detail: "LimitBeacon is reading usage through Codex.",
    action: { kind: "button", label: "Refresh now", command: "refresh" },
  },
  "codex-missing": {
    title: "Codex not found",
    detail: "Install Codex, or check the executable override in Advanced. Then use Test connection.",
    action: {
      kind: "link",
      label: "Install Codex",
      href: "https://developers.openai.com/codex/cli/",
    },
  },
  "sign-in-required": {
    title: "Sign in to Codex",
    detail: "Use the official Codex login, then retry.",
    action: {
      kind: "link",
      label: "Open login guide",
      href: "https://developers.openai.com/codex/auth/",
    },
  },
  starting: {
    title: "Codex is starting",
    detail: "The first connection may take a moment.",
    action: { kind: "button", label: "Please wait", command: "refresh", disabled: true },
  },
  stale: {
    title: "Last update is stale",
    detail: "The last good values remain visible.",
    action: { kind: "button", label: "Retry", command: "refresh" },
  },
  incompatible: {
    title: "Codex changed",
    detail: "Update Codex and retry before reporting a compatibility issue.",
    action: {
      kind: "link",
      label: "Update Codex",
      href: "https://developers.openai.com/codex/cli/",
    },
  },
  error: {
    title: "Could not refresh",
    detail: "Check Codex and try again.",
    action: { kind: "button", label: "Retry", command: "refresh" },
  },
};

export function inspectorStatusModel(status: InspectorStatusId): InspectorStatusModel {
  return models[status];
}
