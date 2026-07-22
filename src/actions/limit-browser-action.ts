import {
  action,
  type DidReceiveSettingsEvent,
  type DialDownEvent,
  type DialRotateEvent,
  SingletonAction,
  type TouchTapEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import { normalizeDialSettings, type DialSettings } from "../domain/dial-settings.js";
import { CodexProviderError } from "../providers/codex-app-server-provider.js";
import { CodexLocatorError } from "../platform/codex-locator.js";
import {
  renderDial,
  renderDialTransition,
  type DialUsageRow,
  type DialViewModel,
} from "../render/dial-renderer.js";
import type {
  UsageService,
  UsageServiceState,
  UsageSubscriber,
} from "../services/usage-service.js";

type Service = Pick<UsageService, "subscribe" | "refresh">;

export type DialTarget = {
  id: string;
  setFeedback(feedback: Record<string, unknown>): Promise<void>;
  setSettings(settings: Record<string, unknown>): Promise<void>;
  showAlert(): Promise<void>;
};

type VisibleDial = {
  target: DialTarget;
  settings: DialSettings;
  state: UsageServiceState;
  unsubscribe: () => void;
  pendingTicks: number;
  rotationTask: Promise<void> | null;
};

export class LimitBrowserController {
  readonly #service: Service;
  readonly #dials = new Map<string, VisibleDial>();

  constructor(service: Service) {
    this.#service = service;
  }

  appear(target: DialTarget, rawSettings: unknown): void {
    this.disappear(target.id);
    const dial: VisibleDial = {
      target,
      settings: normalizeDialSettings(rawSettings),
      state: { status: "idle", snapshot: null, error: null },
      unsubscribe: () => {},
      pendingTicks: 0,
      rotationTask: null,
    };
    const subscriber: UsageSubscriber = (state) => {
      dial.state = state;
      this.#render(dial);
    };
    dial.unsubscribe = this.#service.subscribe(subscriber);
    this.#dials.set(target.id, dial);
  }

  disappear(id: string): void {
    this.#dials.get(id)?.unsubscribe();
    this.#dials.delete(id);
  }

  settingsChanged(id: string, rawSettings: unknown): void {
    const dial = this.#dials.get(id);
    if (dial === undefined) return;
    dial.settings = normalizeDialSettings(rawSettings);
    this.#render(dial);
  }

  async rotate(id: string, ticks: number): Promise<void> {
    const dial = this.#dials.get(id);
    if (dial === undefined || ticks === 0) return;
    dial.pendingTicks += ticks;
    if (dial.rotationTask !== null) {
      await dial.rotationTask;
      return;
    }
    const task = this.#drainRotations(dial);
    dial.rotationTask = task;
    try {
      await task;
    } finally {
      if (dial.rotationTask === task) dial.rotationTask = null;
    }
  }

  async touch(id: string): Promise<void> {
    const dial = this.#dials.get(id);
    if (dial === undefined) return;
    dial.settings.basis = dial.settings.basis === "remaining" ? "used" : "remaining";
    await this.#persistAndRender(dial);
  }

  async press(id: string): Promise<void> {
    const dial = this.#dials.get(id);
    if (dial === undefined) return;
    try {
      await dial.target.setFeedback({
        canvas: svgDataUrl(renderDial({ type: "message", tone: "loading", title: "Refreshing" })),
      });
      await this.#service.refresh();
      this.#render(dial);
    } catch {
      await dial.target.showAlert();
    }
  }

  async #persistAndRender(dial: VisibleDial): Promise<void> {
    try {
      await dial.target.setSettings({ ...dial.settings });
      this.#render(dial);
    } catch {
      await dial.target.showAlert();
    }
  }

  async #drainRotations(dial: VisibleDial): Promise<void> {
    while (dial.pendingTicks !== 0) {
      const ticks = dial.pendingTicks;
      dial.pendingTicks = 0;
      const count = windowCount(dial.state);
      if (count === 0) return;
      const previousSettings = { ...dial.settings };
      if (count === 1) {
        if (Math.abs(ticks) % 2 === 0) continue;
        dial.settings.basis = dial.settings.basis === "remaining" ? "used" : "remaining";
      } else {
        dial.settings.activeIndex = normalizeIndex(dial.settings.activeIndex + ticks, count);
        if (dial.settings.activeIndex === previousSettings.activeIndex) continue;
      }
      await this.#persistAndAnimate(dial, previousSettings, ticks < 0 ? 1 : -1);
    }
  }

  async #persistAndAnimate(
    dial: VisibleDial,
    previousSettings: DialSettings,
    direction: -1 | 1,
  ): Promise<void> {
    try {
      await dial.target.setSettings({ ...dial.settings });
      const from = toViewModel(dial.state, previousSettings);
      const to = toViewModel(dial.state, dial.settings);
      if (from.type !== "usage" || to.type !== "usage") {
        this.#render(dial);
        return;
      }
      for (let frame = 1; frame <= 12; frame += 1) {
        const linearProgress = frame / 13;
        const easedProgress = 1 - (1 - linearProgress) ** 2;
        await dial.target.setFeedback({
          canvas: svgDataUrl(renderDialTransition(from, to, direction, easedProgress)),
        });
        await frameDelay();
      }
      this.#render(dial);
    } catch {
      await dial.target.showAlert();
    }
  }

  #render(dial: VisibleDial): void {
    const image = svgDataUrl(renderDial(toViewModel(dial.state, dial.settings)));
    void dial.target.setFeedback({ canvas: image }).catch(() => dial.target.showAlert());
  }
}

@action({ UUID: "com.jelicanin.limitbeacon.limit-browser" })
export class LimitBrowserAction extends SingletonAction {
  constructor(private readonly controller: LimitBrowserController) {
    super();
  }

  override onWillAppear(event: WillAppearEvent): void {
    if (event.action.isDial()) this.controller.appear(event.action, event.payload.settings);
  }

  override onWillDisappear(event: WillDisappearEvent): void {
    this.controller.disappear(event.action.id);
  }

  override onDidReceiveSettings(event: DidReceiveSettingsEvent): void {
    this.controller.settingsChanged(event.action.id, event.payload.settings);
  }

  override async onDialRotate(event: DialRotateEvent): Promise<void> {
    await this.controller.rotate(event.action.id, event.payload.ticks);
  }

  override async onDialDown(event: DialDownEvent): Promise<void> {
    await this.controller.press(event.action.id);
  }

  override async onTouchTap(event: TouchTapEvent): Promise<void> {
    await this.controller.touch(event.action.id);
  }
}

function toViewModel(state: UsageServiceState, settings: DialSettings): DialViewModel {
  if (state.snapshot !== null) {
    const windows = [
      windowViewModel("5H", state.snapshot.fiveHour, settings.basis),
      ...(state.snapshot.weekly === null
        ? []
        : [windowViewModel("7D", state.snapshot.weekly, settings.basis)]),
    ];
    return {
      type: "usage",
      basis: settings.basis,
      displayStyle: settings.displayStyle,
      activeIndex: normalizeIndex(settings.activeIndex, windows.length),
      stale: state.status === "stale" || state.snapshot.stale,
      windows,
    };
  }

  if (state.status === "idle" || state.status === "loading") {
    return { type: "message", tone: "loading", title: "Starting" };
  }
  if (state.error instanceof CodexLocatorError) {
    return { type: "message", tone: "setup", title: "Install Codex" };
  }
  if (state.error instanceof CodexProviderError && state.error.code === "SIGN_IN_REQUIRED") {
    return { type: "message", tone: "setup", title: "Sign in to Codex" };
  }
  return { type: "message", tone: "error", title: "Press to retry" };
}

function windowViewModel(
  fallbackLabel: string,
  window: {
    remainingPercent: number;
    usedPercent: number;
    durationMinutes: number | null;
    resetsAt: number | null;
  },
  basis: DialSettings["basis"],
): DialUsageRow {
  const remaining = window.remainingPercent;
  return {
    label: formatDuration(window.durationMinutes) ?? fallbackLabel,
    percent: basis === "remaining" ? remaining : window.usedPercent,
    reset: formatReset(window.resetsAt),
    severity: remaining <= 15 ? "critical" : remaining <= 35 ? "warning" : "healthy",
  };
}

function formatDuration(minutes: number | null): string | null {
  if (minutes === null) return null;
  if (minutes % 1_440 === 0) return `${minutes / 1_440}D`;
  if (minutes % 60 === 0) return `${minutes / 60}H`;
  return `${minutes}M`;
}

function formatReset(resetsAt: number | null): string | null {
  if (resetsAt === null) return null;
  const minutes = Math.max(0, Math.ceil((resetsAt * 1000 - Date.now()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function windowCount(state: UsageServiceState): number {
  if (state.snapshot === null) return 0;
  return state.snapshot.weekly === null ? 1 : 2;
}

function normalizeIndex(index: number, count: number): number {
  if (count === 0) return 0;
  return ((index % count) + count) % count;
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function frameDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}
