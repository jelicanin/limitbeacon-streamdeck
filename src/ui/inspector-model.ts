export type InspectorStatusId =
  | "connected"
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

const models: Record<InspectorStatusId, InspectorStatusModel> = {
  connected: {
    title: "Connected",
    detail: "LimitBeacon is reading usage through Codex.",
    action: { kind: "button", label: "Refresh now", command: "refresh" },
  },
  "codex-missing": {
    title: "Codex not found",
    detail: "Install Codex CLI, then retry.",
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
