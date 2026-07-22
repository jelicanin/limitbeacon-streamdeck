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

import type { TokenUsageSnapshot } from "../domain/token-usage.js";
import type { UsageSnapshot } from "../domain/usage.js";
import { CodexLocatorError } from "../platform/codex-locator.js";
import { getSystemLocale } from "../platform/system-locale.js";
import { CodexProviderError } from "../providers/codex-app-server-provider.js";
import {
  renderSpecializedDial,
  renderSpecializedDialTransition,
  type SpecializedCard,
  type SpecializedDialViewModel,
} from "../render/specialized-dial-renderer.js";
import type {
  TokenUsageServiceState,
  TokenUsageSubscriber,
  UsageService,
  UsageServiceState,
  UsageSubscriber,
} from "../services/usage-service.js";

export type SpecializedDialKind = "daily" | "credits" | "activity";

type Service = Pick<
  UsageService,
  "subscribe" | "subscribeTokenUsage" | "refresh" | "refreshTokenUsage"
>;

type SpecializedSettings = {
  activeIndex: number;
  summary: boolean;
};

export type SpecializedDialTarget = {
  id: string;
  setFeedback(feedback: Record<string, unknown>): Promise<void>;
  setSettings(settings: Record<string, unknown>): Promise<void>;
  showAlert(): Promise<void>;
};

type VisibleDial = {
  target: SpecializedDialTarget;
  settings: SpecializedSettings;
  state: UsageServiceState | TokenUsageServiceState;
  unsubscribe: () => void;
  pendingTicks: number;
  rotationTask: Promise<void> | null;
};

export class SpecializedDialController {
  readonly #service: Service;
  readonly #kind: SpecializedDialKind;
  readonly #dials = new Map<string, VisibleDial>();

  constructor(service: Service, kind: SpecializedDialKind) {
    this.#service = service;
    this.#kind = kind;
  }

  appear(target: SpecializedDialTarget, rawSettings: unknown): void {
    this.disappear(target.id);
    const dial: VisibleDial = {
      target,
      settings: normalizeSettings(rawSettings),
      state: { status: "idle", snapshot: null, error: null },
      unsubscribe: () => {},
      pendingTicks: 0,
      rotationTask: null,
    };
    if (this.#kind === "credits") {
      const subscriber: UsageSubscriber = (state) => {
        dial.state = state;
        this.#render(dial);
      };
      dial.unsubscribe = this.#service.subscribe(subscriber);
    } else {
      const subscriber: TokenUsageSubscriber = (state) => {
        dial.state = state;
        this.#render(dial);
      };
      dial.unsubscribe = this.#service.subscribeTokenUsage(subscriber);
    }
    this.#dials.set(target.id, dial);
  }

  disappear(id: string): void {
    this.#dials.get(id)?.unsubscribe();
    this.#dials.delete(id);
  }

  settingsChanged(id: string, rawSettings: unknown): void {
    const dial = this.#dials.get(id);
    if (dial === undefined) return;
    dial.settings = normalizeSettings(rawSettings);
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
    if (dial === undefined || this.#kind !== "daily") return;
    dial.settings.summary = !dial.settings.summary;
    dial.settings.activeIndex = 0;
    await this.#persistAndRender(dial);
  }

  async press(id: string): Promise<void> {
    const dial = this.#dials.get(id);
    if (dial === undefined) return;
    try {
      await dial.target.setFeedback({
        canvas: svgDataUrl(renderSpecializedDial({
          type: "message",
          tone: "loading",
          title: "Refreshing",
        })),
      });
      if (this.#kind === "credits") await this.#service.refresh();
      else await this.#service.refreshTokenUsage();
      this.#render(dial);
    } catch {
      await dial.target.showAlert();
    }
  }

  async #drainRotations(dial: VisibleDial): Promise<void> {
    while (dial.pendingTicks !== 0) {
      const ticks = dial.pendingTicks;
      dial.pendingTicks = 0;
      const from = toViewModel(this.#kind, dial.state, dial.settings);
      if (from.type !== "cards" || from.cards.length < 2) return;
      const previousSettings = { ...dial.settings };
      dial.settings.activeIndex = normalizeIndex(dial.settings.activeIndex + ticks, from.cards.length);
      if (dial.settings.activeIndex === previousSettings.activeIndex) continue;
      await this.#persistAndAnimate(dial, previousSettings, ticks < 0 ? 1 : -1);
    }
  }

  async #persistAndAnimate(
    dial: VisibleDial,
    previousSettings: SpecializedSettings,
    direction: -1 | 1,
  ): Promise<void> {
    try {
      await dial.target.setSettings({ ...dial.settings });
      const from = toViewModel(this.#kind, dial.state, previousSettings);
      const to = toViewModel(this.#kind, dial.state, dial.settings);
      if (from.type !== "cards" || to.type !== "cards") {
        this.#render(dial);
        return;
      }
      for (let frame = 1; frame <= 12; frame += 1) {
        const linearProgress = frame / 13;
        const easedProgress = 1 - (1 - linearProgress) ** 2;
        await dial.target.setFeedback({
          canvas: svgDataUrl(renderSpecializedDialTransition(from, to, direction, easedProgress)),
        });
        await frameDelay();
      }
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

  #render(dial: VisibleDial): void {
    const canvas = svgDataUrl(renderSpecializedDial(toViewModel(this.#kind, dial.state, dial.settings)));
    void dial.target.setFeedback({ canvas }).catch(() => dial.target.showAlert());
  }
}

class SpecializedDialAction extends SingletonAction {
  constructor(private readonly controller: SpecializedDialController) {
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

@action({ UUID: "com.jelicanin.limitbeacon.daily-tokens" })
export class DailyTokensAction extends SpecializedDialAction {}

@action({ UUID: "com.jelicanin.limitbeacon.credits-spend" })
export class CreditsSpendAction extends SpecializedDialAction {}

@action({ UUID: "com.jelicanin.limitbeacon.activity-stats" })
export class ActivityStatsAction extends SpecializedDialAction {}

export function buildDailyCards(
  snapshot: TokenUsageSnapshot,
  summary: boolean,
  now = new Date(),
): SpecializedCard[] {
  if (summary) {
    if (snapshot.daily.length === 0) return [];
    const total = snapshot.daily.reduce((sum, bucket) => sum + bucket.tokens, 0);
    const cards: SpecializedCard[] = [
      statCard("7D TOTAL", compactNumber(total), "TOKENS"),
      statCard("DAILY AVG", compactNumber(Math.round(total / snapshot.daily.length)), "TOKENS"),
    ];
    if (snapshot.summary.peakDailyTokens !== null) {
      cards.push(statCard("PEAK DAY", compactNumber(snapshot.summary.peakDailyTokens), "TOKENS"));
    }
    return cards;
  }

  const newestSeven = snapshot.daily.slice(0, 7);
  const chronological = [...newestSeven].reverse();
  const peak = Math.max(...chronological.map((bucket) => bucket.tokens), 1);
  const bars = chronological.map((bucket) => Math.round((bucket.tokens / peak) * 100));
  const today = localDateKey(now);
  return newestSeven.map((bucket, index) => ({
    kind: "daily",
    label: bucket.startDate === today ? "TODAY" : "DAILY TOKENS",
    value: compactNumber(bucket.tokens),
    detail: formatBucketDate(bucket.startDate),
    bars,
    activeBar: newestSeven.length - 1 - index,
  }));
}

export function buildCreditsCards(snapshot: UsageSnapshot): SpecializedCard[] {
  const health = snapshot.accountHealth;
  const cards: SpecializedCard[] = [];
  if (health.credits !== null) {
    const value = health.credits.unlimited
      ? "UNLIMITED"
      : health.credits.balance ?? (health.credits.hasCredits ? "AVAILABLE" : "NONE");
    cards.push(statCard("CREDIT BALANCE", value, "CODEX CREDITS"));
  }
  if (health.individualLimit !== null) {
    const limit = health.individualLimit;
    cards.push({
      kind: "meter",
      label: "SPEND LEFT",
      value: `${Math.round(limit.remainingPercent)}%`,
      detail: `${limit.used} / ${limit.limit}`,
      percent: limit.remainingPercent,
      tone: severity(limit.remainingPercent),
    });
  }
  if (health.resetCreditsAvailable !== null) {
    cards.push(statCard("RESET CREDITS", String(health.resetCreditsAvailable), "AVAILABLE"));
  }
  if (health.spendControlReached === true || health.rateLimitReachedType !== null) {
    cards.push({ kind: "stat", label: "ACCOUNT STATUS", value: "LIMIT REACHED", detail: "CHECK CODEX", tone: "critical" });
  }
  return cards;
}

export function buildActivityCards(snapshot: TokenUsageSnapshot): SpecializedCard[] {
  const summary = snapshot.summary;
  const cards: SpecializedCard[] = [];
  if (summary.lifetimeTokens !== null) cards.push(statCard("LIFETIME TOKENS", compactNumber(summary.lifetimeTokens), "ALL TIME"));
  if (summary.peakDailyTokens !== null) cards.push(statCard("PEAK DAY", compactNumber(summary.peakDailyTokens), "TOKENS"));
  if (summary.currentStreakDays !== null) cards.push(statCard("CURRENT STREAK", `${summary.currentStreakDays}d`, "DAYS"));
  if (summary.longestStreakDays !== null) cards.push(statCard("LONGEST STREAK", `${summary.longestStreakDays}d`, "DAYS"));
  if (summary.longestRunningTurnSec !== null) cards.push(statCard("LONGEST TURN", compactDuration(summary.longestRunningTurnSec), "DURATION"));
  return cards;
}

function toViewModel(
  kind: SpecializedDialKind,
  state: UsageServiceState | TokenUsageServiceState,
  settings: SpecializedSettings,
): SpecializedDialViewModel {
  if (state.snapshot !== null) {
    const cards = kind === "credits"
      ? buildCreditsCards(state.snapshot as UsageSnapshot)
      : kind === "daily"
      ? buildDailyCards(state.snapshot as TokenUsageSnapshot, settings.summary)
      : buildActivityCards(state.snapshot as TokenUsageSnapshot);
    if (cards.length === 0) return { type: "message", tone: "empty", title: "Not available" };
    return {
      type: "cards",
      activeIndex: normalizeIndex(settings.activeIndex, cards.length),
      stale: state.status === "stale" || state.snapshot.stale,
      cards,
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

function statCard(label: string, value: string, detail: string): SpecializedCard {
  return { kind: "stat", label, value, detail, tone: "healthy" };
}

function normalizeSettings(value: unknown): SpecializedSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { activeIndex: 0, summary: false };
  }
  const record = value as Record<string, unknown>;
  return {
    activeIndex: Number.isSafeInteger(record.activeIndex) ? Number(record.activeIndex) : 0,
    summary: record.summary === true,
  };
}

function compactNumber(value: number): string {
  if (value >= 1_000_000_000) return `${trimDecimal(value / 1_000_000_000)}B`;
  if (value >= 1_000_000) return `${trimDecimal(value / 1_000_000)}M`;
  if (value >= 1_000) return `${trimDecimal(value / 1_000)}K`;
  return String(value);
}

function trimDecimal(value: number): string {
  return value.toFixed(value >= 100 ? 1 : value >= 10 ? 1 : 2).replace(/\.0+$/u, "").replace(/(\.\d*[1-9])0+$/u, "$1");
}

function compactDuration(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  if (days > 0) {
    const hours = Math.floor((seconds % 86_400) / 3_600);
    return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
  }
  const hours = Math.floor(seconds / 3_600);
  if (hours > 0) {
    const minutes = Math.floor((seconds % 3_600) / 60);
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes === 0) return `${remainingSeconds}s`;
  if (remainingSeconds === 0) return `${minutes}m`;
  return `${minutes}m ${remainingSeconds}s`;
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatBucketDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return value;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return new Intl.DateTimeFormat(getSystemLocale(), {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  }).format(new Date(year, month - 1, day));
}

function severity(remainingPercent: number): "healthy" | "warning" | "critical" {
  return remainingPercent <= 15 ? "critical" : remainingPercent <= 35 ? "warning" : "healthy";
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
