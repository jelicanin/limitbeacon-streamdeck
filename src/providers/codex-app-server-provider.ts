import { mapRateLimits, type UsageSnapshot, UsageValidationError } from "../domain/usage.js";
import {
  mapTokenUsage,
  type TokenUsageSnapshot,
  TokenUsageValidationError,
} from "../domain/token-usage.js";
import {
  JsonlRpcProcessError,
  JsonlRpcProtocolError,
  JsonlRpcRemoteError,
} from "./jsonl-rpc-client.js";

const RATE_LIMITS_METHOD = "account/rateLimits/read";
const TOKEN_USAGE_METHOD = "account/usage/read";

export interface UsageProvider {
  read(): Promise<UsageSnapshot>;
  readTokenUsage(): Promise<TokenUsageSnapshot>;
  close(): Promise<void>;
  subscribeUpdates?(subscriber: () => void): () => void;
}

export interface RpcClientLike {
  request<T>(method: string, params: unknown): Promise<T>;
  close(): Promise<void>;
}

export type CodexProviderErrorCode =
  | "SIGN_IN_REQUIRED"
  | "CODEX_INCOMPATIBLE"
  | "CODEX_UNAVAILABLE";

export class CodexProviderError extends Error {
  constructor(readonly code: CodexProviderErrorCode, message: string) {
    super(message);
    this.name = "CodexProviderError";
  }
}

export class CodexAppServerProvider implements UsageProvider {
  readonly #createClient: (
    onNotification: (method: string, params: unknown) => void,
  ) => Promise<RpcClientLike>;
  readonly #updateSubscribers = new Set<() => void>();
  readonly #releases = new Set<Promise<void>>();
  #client: RpcClientLike | undefined;
  #initializing: Promise<RpcClientLike> | undefined;
  #generation = 0;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: {
    createClient: (
      onNotification: (method: string, params: unknown) => void,
    ) => Promise<RpcClientLike>;
  }) {
    this.#createClient = options.createClient;
  }

  subscribeUpdates(subscriber: () => void): () => void {
    this.#updateSubscribers.add(subscriber);
    return () => this.#updateSubscribers.delete(subscriber);
  }

  async read(): Promise<UsageSnapshot> {
    return mapProviderResponse(await this.#request(RATE_LIMITS_METHOD));
  }

  async readTokenUsage(): Promise<TokenUsageSnapshot> {
    try {
      return mapTokenUsage(await this.#request(TOKEN_USAGE_METHOD));
    } catch (error) {
      if (error instanceof TokenUsageValidationError) {
        throw new CodexProviderError(
          "CODEX_INCOMPATIBLE",
          "Codex returned an unsupported token-usage response",
        );
      }
      throw error;
    }
  }

  async #request(method: string): Promise<unknown> {
    if (this.#closed) {
      throw unavailableError("Provider is closed");
    }

    const generation = this.#generation;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let client: RpcClientLike | undefined;
      try {
        client = await this.#getClient();
        this.#assertCurrent(generation);
        return await client.request<unknown>(method, undefined);
      } catch (error) {
        this.#assertCurrent(generation);
        if (error instanceof JsonlRpcProtocolError) {
          await this.#discardClient(client);
          throw new CodexProviderError(
            "CODEX_INCOMPATIBLE",
            "Codex returned an invalid protocol response",
          );
        }
        if (error instanceof JsonlRpcProcessError) {
          await this.#discardClient(client);
          if (attempt === 0) {
            this.#assertCurrent(generation);
            continue;
          }
          throw unavailableError("Codex App Server stopped repeatedly");
        }
        throw mapProviderError(error);
      }
    }

    throw unavailableError("Codex App Server is unavailable");
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }
    this.#closed = true;
    this.#generation += 1;
    this.#updateSubscribers.clear();
    const release = this.#releaseClient();
    this.#closePromise = Promise.all([...this.#releases, release]).then(() => undefined);
    return this.#closePromise;
  }

  async reset(): Promise<void> {
    if (this.#closed) return;
    this.#generation += 1;
    await this.#releaseClient();
  }

  #releaseClient(): Promise<void> {
    const client = this.#client;
    const initializing = this.#initializing;
    this.#client = undefined;
    this.#initializing = undefined;
    return this.#trackRelease(Promise.all([
      client?.close(),
      // The old initialization owns closing any client that arrives after invalidation.
      initializing?.catch(() => undefined),
    ]).then(() => undefined));
  }

  #trackRelease(release: Promise<void>): Promise<void> {
    this.#releases.add(release);
    void release.then(
      () => { this.#releases.delete(release); },
      () => { this.#releases.delete(release); },
    );
    return release;
  }

  #assertCurrent(generation: number): void {
    if (this.#closed || generation !== this.#generation) {
      throw unavailableError(this.#closed ? "Provider is closed" : "Provider was reset");
    }
  }

  async #getClient(): Promise<RpcClientLike> {
    this.#assertCurrent(this.#generation);
    if (this.#client !== undefined) return this.#client;
    if (this.#initializing !== undefined) return this.#initializing;

    const generation = this.#generation;
    const initializing = this.#initializeClient(generation);
    this.#initializing = initializing;
    try {
      return await initializing;
    } finally {
      if (this.#initializing === initializing) this.#initializing = undefined;
    }
  }

  async #initializeClient(generation: number): Promise<RpcClientLike> {
    const client = await this.#createClient((method) => {
      if (!this.#closed && generation === this.#generation) this.#receiveNotification(method);
    });
    if (this.#closed || generation !== this.#generation) {
      await client.close();
      this.#assertCurrent(generation);
    }
    this.#client = client;
    return client;
  }

  async #discardClient(failedClient: RpcClientLike | undefined): Promise<void> {
    if (failedClient !== undefined && this.#client === failedClient) {
      this.#client = undefined;
      await this.#trackRelease(failedClient.close());
    }
  }

  #receiveNotification(method: string): void {
    if (method !== "account/rateLimits/updated") return;
    for (const subscriber of this.#updateSubscribers) {
      subscriber();
    }
  }
}

function mapProviderResponse(response: unknown): UsageSnapshot {
  try {
    const record = isRecord(response) ? response : undefined;
    const byLimitId = isRecord(record?.rateLimitsByLimitId)
      ? record.rateLimitsByLimitId
      : undefined;
    const rateLimits = isRecord(byLimitId?.codex) ? byLimitId.codex : record?.rateLimits;
    return mapRateLimits({
      rateLimits,
      rateLimitResetCredits: record?.rateLimitResetCredits,
    });
  } catch (error) {
    if (error instanceof UsageValidationError) {
      throw new CodexProviderError(
        "CODEX_INCOMPATIBLE",
        "Codex returned an unsupported rate-limit response",
      );
    }
    throw error;
  }
}

function mapProviderError(error: unknown): Error {
  if (error instanceof CodexProviderError) {
    return error;
  }
  if (error instanceof JsonlRpcRemoteError) {
    if (
      error.code === -32_600 &&
      /authentication required|sign[ -]?in required|not logged in/iu.test(error.message)
    ) {
      return new CodexProviderError("SIGN_IN_REQUIRED", "Sign in to Codex to read usage limits");
    }
    return new CodexProviderError(
      "CODEX_INCOMPATIBLE",
      "Codex App Server rejected the rate-limit request",
    );
  }
  return error instanceof Error ? error : unavailableError("Codex App Server is unavailable");
}

function unavailableError(message: string): CodexProviderError {
  return new CodexProviderError("CODEX_UNAVAILABLE", message);
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
