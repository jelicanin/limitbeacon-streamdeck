import { CodexLocatorError } from "../platform/codex-locator.js";
import { CodexProviderError } from "../providers/codex-app-server-provider.js";
import type { UsageServiceState } from "../services/usage-service.js";
import type { InspectorStatusId } from "./inspector-model.js";

type InspectorState = Pick<UsageServiceState, "status" | "error">;
export type InspectorSender = (payload: { status: InspectorStatusId }) => Promise<void>;
type Subscribe = (subscriber: (state: InspectorState) => void) => () => void;

export class InspectorConnection {
  readonly #subscribe: Subscribe;
  #current: { id: string; unsubscribe: () => void } | undefined;

  constructor(subscribe: Subscribe) {
    this.#subscribe = subscribe;
  }

  appear(id: string, send: InspectorSender): void {
    this.#current?.unsubscribe();
    const current = { id, unsubscribe: () => {} };
    this.#current = current;
    current.unsubscribe = this.#subscribe((state) => {
      if (this.#current !== current) return;
      void send({ status: inspectorStatus(state) }).catch(() => {
        // An inspector can close while its last status is being sent.
      });
    });
  }

  disappear(id: string): void {
    if (this.#current?.id !== id) return;
    this.#current.unsubscribe();
    this.#current = undefined;
  }
}

export function isInspectorRefreshCommand(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>).command === "refresh";
}

function inspectorStatus(state: InspectorState): InspectorStatusId {
  if (state.status === "ready") return "connected";
  if (state.status === "stale") return "stale";
  if (state.status === "idle" || state.status === "loading") return "starting";
  if (state.error instanceof CodexLocatorError) return "codex-missing";
  if (state.error instanceof CodexProviderError) {
    if (state.error.code === "SIGN_IN_REQUIRED") return "sign-in-required";
    if (state.error.code === "CODEX_INCOMPATIBLE") return "incompatible";
  }
  return "error";
}
