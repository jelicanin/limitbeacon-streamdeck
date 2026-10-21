import type { UsageSnapshot } from "../domain/usage.js";
import type { UsageCollection } from "../domain/limit-groups.js";
import type { TokenUsageSnapshot } from "../domain/token-usage.js";
import type { UsageProvider } from "../providers/codex-app-server-provider.js";

const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60_000;
const COUNTDOWN_INTERVAL_MS = 60_000;

export type UsageServiceStatus =
  "idle" | "loading" | "ready" | "stale" | "error";

export type UsageServiceState = {
  status: UsageServiceStatus;
  snapshot: UsageSnapshot | null;
  error: Error | null;
  collection?: UsageCollection;
  groupLabel?: string;
  groupUnavailable?: boolean;
};

export type UsageSubscriber = (state: UsageServiceState) => void;

export type TokenUsageServiceState = {
  status: UsageServiceStatus;
  snapshot: TokenUsageSnapshot | null;
  error: Error | null;
};

export type TokenUsageSubscriber = (state: TokenUsageServiceState) => void;

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
  readonly #unsubscribeProviderUpdates: () => void;
  #refreshIntervalMs: number;
  readonly #timers: UsageServiceTimerDependencies;
  readonly #subscribers = new Set<UsageSubscriber>();
  readonly #tokenSubscribers = new Set<TokenUsageSubscriber>();
  #state: UsageServiceState = { status: "idle", snapshot: null, error: null };
  #tokenState: TokenUsageServiceState = {
    status: "idle",
    snapshot: null,
    error: null,
  };
  #inFlight: Promise<UsageServiceState> | undefined;
  #refreshQueued = false;
  #tokenInFlight: Promise<TokenUsageServiceState> | undefined;
  #tokenEpoch = 0;
  #pollTimer: unknown;
  #countdownTimer: unknown;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(provider: UsageProvider, options: UsageServiceOptions = {}) {
    this.#provider = provider;
    this.#unsubscribeProviderUpdates =
      provider.subscribeUpdates?.(() => {
        if (this.#closed || this.#subscribers.size === 0) return;
        if (this.#inFlight !== undefined) {
          this.#refreshQueued = true;
          return;
        }
        void this.refresh().catch(() => {
          // The stale or error state has already been published.
        });
      }) ?? (() => {});
    this.#refreshIntervalMs =
      options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    this.#timers = options.timers ?? defaultTimers;
    if (
      !Number.isSafeInteger(this.#refreshIntervalMs) ||
      this.#refreshIntervalMs <= 0
    ) {
      throw new RangeError("refreshIntervalMs must be a positive integer");
    }
  }

  subscribe(subscriber: UsageSubscriber): () => void {
    if (this.#closed) {
      throw new Error("UsageService is closed");
    }

    const wasInactive = this.#subscriberCount() === 0;
    this.#subscribers.add(subscriber);
    subscriber(this.#state);
    if (wasInactive) {
      this.#startTimers();
    }
    if (this.#subscribers.size === 1) {
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
      if (this.#subscriberCount() === 0) {
        this.#stopTimers();
      }
    };
  }

  subscribeTokenUsage(subscriber: TokenUsageSubscriber): () => void {
    if (this.#closed) throw new Error("UsageService is closed");

    const wasInactive = this.#subscriberCount() === 0;
    this.#tokenSubscribers.add(subscriber);
    subscriber(this.#tokenState);
    if (wasInactive) this.#startTimers();
    if (this.#tokenSubscribers.size === 1) {
      void this.refreshTokenUsage().catch(() => {
        // The current error state is delivered to subscribers by refreshTokenUsage().
      });
    }

    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.#tokenSubscribers.delete(subscriber);
      if (this.#subscriberCount() === 0) this.#stopTimers();
    };
  }

  getState(): UsageServiceState {
    return this.#state;
  }

  getTokenUsageState(): TokenUsageServiceState {
    return this.#tokenState;
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
    if (this.#subscriberCount() > 0) {
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
    if (this.#state.snapshot === null && this.#state.collection === undefined) {
      this.#state = { status: "loading", snapshot: null, error: null };
      this.#notify();
    }

    const operation = Promise.resolve()
      .then(() => this.#provider.read())
      .then((incoming) => {
        const previous = this.#state.collection;
        const accountId = incoming.accountId ?? null;
        const previousAccountId = previous?.accountId ?? null;
        const accountChanged = accountId !== previousAccountId;
        const permission = incoming.ordinaryUsageAllowed ?? null;
        const ordinaryUsageAllowed =
          permission === null &&
          accountId === previousAccountId &&
          previous?.ordinaryUsageAllowed === false
            ? false
            : permission;
        const collection = {
          ...incoming,
          accountId,
          ordinaryUsageAllowed,
          groups: incoming.groups.map((group) => {
            const old = accountChanged
              ? null
              : previous?.groups.find((candidate) => candidate.id === group.id)
                  ?.snapshot;
            const snapshot =
              group.snapshot ?? (old == null ? null : { ...old, stale: true });
            return snapshot === null
              ? group
              : {
                  ...group,
                  snapshot: {
                    ...snapshot,
                    accountHealth: {
                      ...snapshot.accountHealth,
                      ordinaryUsageAllowed,
                    },
                  },
                };
          }),
        };
        this.#state = selectUsageGroup(
          { status: "ready", snapshot: null, error: null, collection },
          "",
        );
        if (accountChanged) this.#invalidateTokenUsage();
        this.#notify();
        return this.#state;
      })
      .catch((error: unknown) => {
        const normalized =
          error instanceof Error ? error : new Error("Usage refresh failed");
        const previous = this.#state.snapshot;
        const collection =
          this.#state.collection === undefined
            ? undefined
            : {
                ...this.#state.collection,
                groups: this.#state.collection.groups.map((group) => ({
                  ...group,
                  snapshot:
                    group.snapshot === null
                      ? null
                      : { ...group.snapshot, stale: true },
                })),
              };
        this.#state = {
          ...(collection === undefined ? {} : { collection }),
          ...(previous === null
            ? { status: "error", snapshot: null, error: normalized }
            : {
                status: "stale",
                snapshot: { ...previous, stale: true },
                error: normalized,
              }),
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

  refreshTokenUsage(): Promise<TokenUsageServiceState> {
    if (this.#closed)
      return Promise.reject(new Error("UsageService is closed"));
    if (this.#tokenInFlight !== undefined) return this.#tokenInFlight;
    if (this.#tokenState.snapshot === null) {
      this.#tokenState = { status: "loading", snapshot: null, error: null };
      this.#notifyTokens();
    }

    const epoch = this.#tokenEpoch;
    const operation = Promise.resolve()
      .then(() => this.#provider.readTokenUsage())
      .then((snapshot) => {
        if (epoch !== this.#tokenEpoch)
          throw new Error("Account changed during token usage refresh");
        this.#tokenState = {
          status: "ready",
          snapshot: { ...snapshot, stale: false },
          error: null,
        };
        this.#notifyTokens();
        return this.#tokenState;
      })
      .catch((error: unknown) => {
        const normalized =
          error instanceof Error
            ? error
            : new Error("Token usage refresh failed");
        if (epoch !== this.#tokenEpoch) throw normalized;
        const previous = this.#tokenState.snapshot;
        this.#tokenState =
          previous === null
            ? { status: "error", snapshot: null, error: normalized }
            : {
                status: "stale",
                snapshot: { ...previous, stale: true },
                error: normalized,
              };
        this.#notifyTokens();
        throw normalized;
      });

    this.#tokenInFlight = operation;
    void operation.then(
      () => this.#finishTokenRefresh(operation),
      () => this.#finishTokenRefresh(operation),
    );
    return operation;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }
    this.#closed = true;
    this.#unsubscribeProviderUpdates();
    this.#stopTimers();
    this.#subscribers.clear();
    this.#tokenSubscribers.clear();
    this.#closePromise = this.#provider.close();
    return this.#closePromise;
  }

  #finishRefresh(operation: Promise<UsageServiceState>): void {
    if (this.#inFlight === operation) {
      this.#inFlight = undefined;
      if (this.#refreshQueued) {
        this.#refreshQueued = false;
        if (!this.#closed && this.#subscribers.size > 0)
          void this.refresh().catch(() => {});
      }
    }
  }

  #finishTokenRefresh(operation: Promise<TokenUsageServiceState>): void {
    if (this.#tokenInFlight === operation) this.#tokenInFlight = undefined;
  }

  #invalidateTokenUsage(): void {
    this.#tokenEpoch += 1;
    this.#tokenInFlight = undefined;
    this.#tokenState = { status: "idle", snapshot: null, error: null };
    this.#notifyTokens();
    if (!this.#closed && this.#tokenSubscribers.size > 0) {
      void this.refreshTokenUsage().catch(() => {
        // Only the current account's request may publish token state.
      });
    }
  }

  #startTimers(): void {
    this.#pollTimer = this.#timers.setInterval(() => {
      if (this.#subscribers.size > 0) {
        void this.refresh().catch(() => {
          // The stale or error state has already been published.
        });
      }
      if (this.#tokenSubscribers.size > 0) {
        void this.refreshTokenUsage().catch(() => {
          // The stale or error state has already been published.
        });
      }
    }, this.#refreshIntervalMs);
    this.#countdownTimer = this.#timers.setInterval(
      () => this.rerender(),
      COUNTDOWN_INTERVAL_MS,
    );
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

  #notifyTokens(): void {
    for (const subscriber of this.#tokenSubscribers)
      subscriber(this.#tokenState);
  }

  #subscriberCount(): number {
    return this.#subscribers.size + this.#tokenSubscribers.size;
  }
}

/** Select from one shared read; never substitute another group for an explicit selection. */
export function selectUsageGroup(
  state: UsageServiceState,
  groupId: string,
): UsageServiceState {
  if (state.collection === undefined) return state;
  const group = state.collection.groups.find(
    (item) => item.id === (groupId || state.collection!.defaultGroupId),
  );
  if (group?.snapshot == null) {
    const { groupLabel: _label, ...rest } = state;
    return {
      ...rest,
      status: "error",
      snapshot: null,
      ...(group ? { groupLabel: group.label } : {}),
      groupUnavailable: true,
    };
  }
  const stale = group.snapshot.stale;
  return {
    ...state,
    snapshot: group.snapshot,
    status: stale ? "stale" : "ready",
    groupLabel: group.label,
    groupUnavailable: false,
  };
}
