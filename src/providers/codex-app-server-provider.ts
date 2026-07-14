import { mapRateLimits, type UsageSnapshot, UsageValidationError } from "../domain/usage.js";
import {
  JsonlRpcProcessError,
  JsonlRpcRemoteError,
} from "./jsonl-rpc-client.js";

const RATE_LIMITS_METHOD = "account/rateLimits/read";

export interface UsageProvider {
  read(): Promise<UsageSnapshot>;
  close(): Promise<void>;
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
  readonly #createClient: () => Promise<RpcClientLike>;
  #client: RpcClientLike | undefined;
  #generation = 0;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: { createClient: () => Promise<RpcClientLike> }) {
    this.#createClient = options.createClient;
  }

  async read(): Promise<UsageSnapshot> {
    if (this.#closed) {
      throw unavailableError("Provider is closed");
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      let client: RpcClientLike | undefined;
      try {
        client = await this.#getClient();
        const response = await client.request<unknown>(RATE_LIMITS_METHOD, undefined);
        return mapProviderResponse(response);
      } catch (error) {
        if (error instanceof JsonlRpcProcessError) {
          await this.#discardClient(client);
          if (attempt === 0) {
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
    const client = this.#client;
    this.#client = undefined;
    this.#closePromise = client?.close() ?? Promise.resolve();
    return this.#closePromise;
  }

  async reset(): Promise<void> {
    if (this.#closed) return;
    this.#generation += 1;
    const client = this.#client;
    this.#client = undefined;
    await client?.close();
  }

  async #getClient(): Promise<RpcClientLike> {
    if (this.#client !== undefined) {
      return this.#client;
    }
    const generation = this.#generation;
    const client = await this.#createClient();
    if (this.#closed || generation !== this.#generation) {
      await client.close();
      throw unavailableError(this.#closed ? "Provider is closed" : "Provider was reset");
    }
    this.#client = client;
    return client;
  }

  async #discardClient(failedClient: RpcClientLike | undefined): Promise<void> {
    if (failedClient !== undefined && this.#client === failedClient) {
      this.#client = undefined;
      await failedClient.close();
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
    return mapRateLimits({ rateLimits });
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
