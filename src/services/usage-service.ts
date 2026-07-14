import type { UsageSnapshot } from "../domain/usage.js";
import type { UsageProvider } from "../providers/codex-app-server-provider.js";

const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60_000;
const COUNTDOWN_INTERVAL_MS = 60_000;

export type UsageServiceStatus = "idle" | "loading" | "ready" | "stale" | "error";

export type UsageServiceState = {
  status: UsageServiceStatus;
  snapshot: UsageSnapshot | null;
  error: Error | null;
};

export type UsageSubscriber = (state: UsageServiceState) => void;

export interface UsageServiceTimerDependencies {
  setInterval(callback: () => void, delay: number): unknown;
  clearInterval(id: unknown): void;
}

export type UsageServiceOptions = {
  refreshIntervalMs?: number;
  timers?: UsageServiceTimerDependencies;
};

const defaultTimers: UsageServiceTimerDependencies = {
  setInterval: (callback, delay) => setInterval(callback, delay),
  clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
};

export class UsageService {
  readonly #provider: UsageProvider;
  #refreshIntervalMs: number;
  readonly #timers: UsageServiceTimerDependencies;
  readonly #subscribers = new Set<UsageSubscriber>();
  #state: UsageServiceState = { status: "idle", snapshot: null, error: null };
  #inFlight: Promise<UsageServiceState> | undefined;
  #pollTimer: unknown;
  #countdownTimer: unknown;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(provider: UsageProvider, options: UsageServiceOptions = {}) {
    this.#provider = provider;
    this.#refreshIntervalMs = options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.#timers = options.timers ?? defaultTimers;
    if (!Number.isSafeInteger(this.#refreshIntervalMs) || this.#refreshIntervalMs <= 0) {
      throw new RangeError("refreshIntervalMs must be a positive integer");
    }
  }

  subscribe(subscriber: UsageSubscriber): () => void {
    if (this.#closed) {
      throw new Error("UsageService is closed");
    }

    const wasEmpty = this.#subscribers.size === 0;
    this.#subscribers.add(subscriber);
    subscriber(this.#state);
    if (wasEmpty) {
      this.#startTimers();
      void this.refresh().catch(() => {
        // The current error state is delivered to subscribers by refresh().
      });
    }

    let subscribed = true;
    return () => {
      if (!subscribed) {
        return;
      }
      subscribed = false;
      this.#subscribers.delete(subscriber);
      if (this.#subscribers.size === 0) {
        this.#stopTimers();
      }
    };
  }

  getState(): UsageServiceState {
    return this.#state;
  }

  rerender(): void {
    if (!this.#closed) {
      this.#notify();
    }
  }

  setRefreshInterval(refreshIntervalMs: number): void {
    if (!Number.isSafeInteger(refreshIntervalMs) || refreshIntervalMs <= 0) {
      throw new RangeError("refreshIntervalMs must be a positive integer");
    }
    if (refreshIntervalMs === this.#refreshIntervalMs) return;
    this.#refreshIntervalMs = refreshIntervalMs;
    if (this.#subscribers.size > 0) {
      this.#stopTimers();
      this.#startTimers();
    }
  }

  refresh(): Promise<UsageServiceState> {
    if (this.#closed) {
      return Promise.reject(new Error("UsageService is closed"));
    }
    if (this.#inFlight !== undefined) {
      return this.#inFlight;
    }
    if (this.#state.snapshot === null) {
      this.#state = { status: "loading", snapshot: null, error: null };
      this.#notify();
    }

    const operation = Promise.resolve()
      .then(() => this.#provider.read())
      .then((snapshot) => {
        this.#state = {
          status: "ready",
          snapshot: { ...snapshot, stale: false },
          error: null,
        };
        this.#notify();
        return this.#state;
      })
      .catch((error: unknown) => {
        const normalized = error instanceof Error ? error : new Error("Usage refresh failed");
        const previous = this.#state.snapshot;
        this.#state =
          previous === null
            ? { status: "error", snapshot: null, error: normalized }
            : {
                status: "stale",
                snapshot: { ...previous, stale: true },
                error: normalized,
              };
        this.#notify();
        throw normalized;
      });

    this.#inFlight = operation;
    void operation.then(
      () => this.#finishRefresh(operation),
      () => this.#finishRefresh(operation),
    );
    return operation;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }
    this.#closed = true;
    this.#stopTimers();
    this.#subscribers.clear();
    this.#closePromise = this.#provider.close();
    return this.#closePromise;
  }

  #finishRefresh(operation: Promise<UsageServiceState>): void {
    if (this.#inFlight === operation) {
      this.#inFlight = undefined;
    }
  }

  #startTimers(): void {
    this.#pollTimer = this.#timers.setInterval(() => {
      void this.refresh().catch(() => {
        // The stale or error state has already been published.
      });
    }, this.#refreshIntervalMs);
    this.#countdownTimer = this.#timers.setInterval(() => this.rerender(), COUNTDOWN_INTERVAL_MS);
  }

  #stopTimers(): void {
    if (this.#pollTimer !== undefined) {
      this.#timers.clearInterval(this.#pollTimer);
      this.#pollTimer = undefined;
    }
    if (this.#countdownTimer !== undefined) {
      this.#timers.clearInterval(this.#countdownTimer);
      this.#countdownTimer = undefined;
    }
  }

  #notify(): void {
    for (const subscriber of this.#subscribers) {
      subscriber(this.#state);
    }
  }
}
