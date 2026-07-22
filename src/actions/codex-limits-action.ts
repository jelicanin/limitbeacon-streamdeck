import {
  action,
  type DidReceiveSettingsEvent,
  type KeyDownEvent,
  type PropertyInspectorDidAppearEvent,
  type PropertyInspectorDidDisappearEvent,
  type SendToPluginEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import { normalizeSettings, type LimitBeaconSettings } from "../domain/settings.js";
import { CodexProviderError } from "../providers/codex-app-server-provider.js";
import { CodexLocatorError } from "../platform/codex-locator.js";
import { getSystemLocale } from "../platform/system-locale.js";
import { renderKey, type KeyViewModel, type Severity } from "../render/key-renderer.js";
import type {
  UsageService,
  UsageServiceState,
  UsageSubscriber,
} from "../services/usage-service.js";

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

type Service = Pick<UsageService, "subscribe" | "refresh" | "rerender">;

export type KeyTarget = {
  id: string;
  setImage(image: string): Promise<void>;
  showOk(): Promise<void>;
  showAlert(): Promise<void>;
};

type VisibleKey = {
  target: KeyTarget;
  settings: LimitBeaconSettings;
  unsubscribe: () => void;
};

type Inspector = {
  keyId: string;
  send(payload: JsonValue): Promise<void>;
};

export class CodexLimitsController {
  readonly #service: Service;
  readonly #keys = new Map<string, VisibleKey>();
  #inspector: Inspector | undefined;

  constructor(service: Service) {
    this.#service = service;
  }

  appear(target: KeyTarget, rawSettings: unknown): void {
    this.disappear(target.id);
    const key: VisibleKey = {
      target,
      settings: normalizeSettings(rawSettings),
      unsubscribe: () => {},
    };
    const subscriber: UsageSubscriber = (state) => this.#render(key, state);
    key.unsubscribe = this.#service.subscribe(subscriber);
    this.#keys.set(target.id, key);
  }

  disappear(id: string): void {
    this.#keys.get(id)?.unsubscribe();
    this.#keys.delete(id);
  }

  keySettingsChanged(id: string, rawSettings: unknown): void {
    const key = this.#keys.get(id);
    if (key === undefined) return;
    try {
      key.settings = normalizeSettings(rawSettings);
      this.#service.rerender();
    } catch {
      void key.target.showAlert();
    }
  }

  inspectorAppeared(keyId: string, send: Inspector["send"]): void {
    this.#inspector = { keyId, send };
    this.#service.rerender();
  }

  inspectorDisappeared(keyId: string): void {
    if (this.#inspector?.keyId === keyId) this.#inspector = undefined;
  }

  async keyDown(id: string): Promise<void> {
    const key = this.#keys.get(id);
    if (key === undefined) return;

    try {
      await this.#service.refresh();
      await key.target.showOk();
    } catch {
      await key.target.showAlert();
    }
  }

  #render(key: VisibleKey, state: UsageServiceState): void {
    const image = renderKey(toViewModel(state, key.settings));
    void key.target.setImage(svgDataUrl(image)).catch(() => key.target.showAlert());
    if (this.#inspector?.keyId === key.target.id) {
      void this.#inspector.send({ status: inspectorStatus(state) }).catch(() => {});
    }
  }
}

@action({ UUID: "com.jelicanin.limitbeacon.codex-limits" })
export class CodexLimitsAction extends SingletonAction {
  constructor(
    private readonly controller: CodexLimitsController,
    private readonly sendToPropertyInspector: (payload: JsonValue) => Promise<void> = async () => {},
  ) {
    super();
  }

  override onWillAppear(event: WillAppearEvent): void {
    if (event.action.isKey()) {
      this.controller.appear(event.action, event.payload.settings);
    }
  }

  override onWillDisappear(event: WillDisappearEvent): void {
    this.controller.disappear(event.action.id);
  }

  override onDidReceiveSettings(event: DidReceiveSettingsEvent): void {
    this.controller.keySettingsChanged(event.action.id, event.payload.settings);
  }

  override async onKeyDown(event: KeyDownEvent): Promise<void> {
    await this.controller.keyDown(event.action.id);
  }

  override onPropertyInspectorDidAppear(event: PropertyInspectorDidAppearEvent): void {
    this.controller.inspectorAppeared(event.action.id, this.sendToPropertyInspector);
  }

  override onPropertyInspectorDidDisappear(event: PropertyInspectorDidDisappearEvent): void {
    this.controller.inspectorDisappeared(event.action.id);
  }

  override async onSendToPlugin(event: SendToPluginEvent<JsonValue, JsonObject>): Promise<void> {
    if (isRefreshCommand(event.payload)) await this.controller.keyDown(event.action.id);
  }
}

function toViewModel(
  state: UsageServiceState,
  settings: LimitBeaconSettings,
): KeyViewModel {
  if (state.snapshot !== null) {
    return {
      type: "usage",
      basis: settings.basis,
      displayStyle: settings.displayStyle,
      stale: state.status === "stale" || state.snapshot.stale,
      fiveHour: windowViewModel(state.snapshot.fiveHour, settings),
      weekly:
        state.snapshot.weekly === null
          ? null
          : windowViewModel(state.snapshot.weekly, settings),
    };
  }

  if (state.status === "idle" || state.status === "loading") {
    return { type: "message", tone: "loading", title: "Codex is starting", hint: "Please wait" };
  }
  if (state.error instanceof CodexLocatorError) {
    return { type: "message", tone: "setup", title: "Install Codex", hint: "Open setup" };
  }
  if (state.error instanceof CodexProviderError) {
    if (state.error.code === "SIGN_IN_REQUIRED") {
      return { type: "message", tone: "setup", title: "Sign in to Codex", hint: "Then press retry" };
    }
    if (state.error.code === "CODEX_INCOMPATIBLE") {
      return { type: "message", tone: "error", title: "Codex changed", hint: "Open support" };
    }
  }
  return { type: "message", tone: "error", title: "Could not refresh", hint: "Press to retry" };
}

function windowViewModel(
  window: {
    remainingPercent: number;
    usedPercent: number;
    durationMinutes: number | null;
    resetsAt: number | null;
  },
  settings: LimitBeaconSettings,
): { label: string; percent: number; reset: string | null; severity: Severity } {
  return {
    label: formatWindowDuration(window.durationMinutes),
    percent: settings.basis === "remaining" ? window.remainingPercent : window.usedPercent,
    reset: formatReset(window.resetsAt, settings.resetStyle),
    severity: severity(window.remainingPercent, settings),
  };
}

function formatWindowDuration(minutes: number | null): string {
  if (minutes === null) return "LIMIT";
  if (minutes % 1_440 === 0) return `${minutes / 1_440}D`;
  if (minutes % 60 === 0) return `${minutes / 60}H`;
  return `${minutes}M`;
}

function severity(remaining: number, settings: LimitBeaconSettings): Severity {
  if (remaining <= settings.criticalThreshold) return "critical";
  if (remaining <= settings.warningThreshold) return "warning";
  return "healthy";
}

function formatReset(
  resetsAt: number | null,
  style: LimitBeaconSettings["resetStyle"],
): string | null {
  if (resetsAt === null) return null;
  if (style === "local-time") {
    return new Intl.DateTimeFormat(getSystemLocale(), {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(resetsAt * 1000));
  }

  const minutes = Math.max(0, Math.ceil((resetsAt * 1000 - Date.now()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function isRefreshCommand(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>).command === "refresh";
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function inspectorStatus(state: UsageServiceState): string {
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
