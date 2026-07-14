import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const CLOSE_GRACE_MS = 250;

export type StartOptions = {
  executable: string;
  args: readonly string[];
  initializeParams: unknown;
  requestTimeoutMs?: number;
  maxLineBytes?: number;
};

export class JsonlRpcProtocolError extends Error {
  readonly code: "MALFORMED_JSON" | "INVALID_MESSAGE" | "LINE_TOO_LONG";

  constructor(code: JsonlRpcProtocolError["code"], message: string) {
    super(message);
    this.name = "JsonlRpcProtocolError";
    this.code = code;
  }
}

export class JsonlRpcRemoteError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "JsonlRpcRemoteError";
    this.code = code;
    this.data = data;
  }
}

export class JsonlRpcTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`JSONL-RPC request '${method}' timed out after ${timeoutMs} ms`);
    this.name = "JsonlRpcTimeoutError";
  }
}

export type ProcessDiagnosticReason = "PROCESS_EXITED" | "SPAWN_FAILED" | "STDERR_PRESENT";

export class JsonlRpcProcessError extends Error {
  readonly exitCode: number | null;
  readonly diagnosticReason: ProcessDiagnosticReason;

  constructor(
    message: string,
    exitCode: number | null,
    diagnosticReason: ProcessDiagnosticReason,
  ) {
    super(message);
    this.name = "JsonlRpcProcessError";
    this.exitCode = exitCode;
    this.diagnosticReason = diagnosticReason;
  }
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
};

type JsonObject = Record<string, unknown>;

export class JsonlRpcClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #requestTimeoutMs: number;
  readonly #maxLineBytes: number;
  readonly #pending = new Map<number, PendingRequest>();
  #nextId = 0;
  #stdoutBuffer = Buffer.alloc(0);
  #stderrPresent = false;
  #closed = false;
  #exited = false;
  #fatalError: Error | undefined;
  #closePromise: Promise<void> | undefined;
  readonly #exitPromise: Promise<void>;
  #resolveExit!: () => void;

  private constructor(child: ChildProcessWithoutNullStreams, options: StartOptions) {
    this.#child = child;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.#exitPromise = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });

    child.stdout.on("data", (chunk: Buffer) => this.#receiveStdout(chunk));
    child.stderr.on("data", () => {
      this.#stderrPresent = true;
    });
    child.once("error", () => {
      this.#fail(
        new JsonlRpcProcessError(
          "Codex App Server process could not be started",
          null,
          "SPAWN_FAILED",
        ),
      );
    });
    child.once("close", (code) => this.#handleClose(code));
  }

  static async start(options: StartOptions): Promise<JsonlRpcClient> {
    validatePositiveInteger(options.requestTimeoutMs, "requestTimeoutMs");
    validatePositiveInteger(options.maxLineBytes, "maxLineBytes");

    const child = spawn(options.executable, [...options.args], {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const client = new JsonlRpcClient(child, options);

    try {
      await client.request("initialize", options.initializeParams);
      client.#send({ method: "initialized" });
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  request<T>(method: string, params: unknown, timeoutMs = this.#requestTimeoutMs): Promise<T> {
    if (this.#fatalError !== undefined) {
      return Promise.reject(this.#fatalError);
    }
    if (this.#closed || this.#exited) {
      return Promise.reject(
        new JsonlRpcProcessError("JSONL-RPC client is closed", null, "PROCESS_EXITED"),
      );
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      return Promise.reject(new RangeError("timeoutMs must be a positive integer"));
    }

    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) {
          reject(new JsonlRpcTimeoutError(method, timeoutMs));
        }
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      try {
        this.#send({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error("Failed to send JSONL-RPC request"));
      }
    });
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }

    this.#closed = true;
    this.#rejectPending(
      new JsonlRpcProcessError("JSONL-RPC client was closed", null, "PROCESS_EXITED"),
    );
    this.#closePromise = this.#closeProcess();
    return this.#closePromise;
  }

  async #closeProcess(): Promise<void> {
    if (this.#exited) {
      return;
    }

    this.#child.stdin.end();
    const forceKill = setTimeout(() => {
      if (!this.#exited) {
        this.#child.kill();
      }
    }, CLOSE_GRACE_MS);
    forceKill.unref();
    await this.#exitPromise;
    clearTimeout(forceKill);
  }

  #send(message: JsonObject): void {
    if (this.#closed || this.#exited || this.#child.stdin.destroyed) {
      throw new JsonlRpcProcessError("JSONL-RPC client is closed", null, "PROCESS_EXITED");
    }
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #receiveStdout(chunk: Buffer): void {
    if (this.#fatalError !== undefined) {
      return;
    }

    this.#stdoutBuffer = Buffer.concat([this.#stdoutBuffer, chunk]);
    let newlineIndex = this.#stdoutBuffer.indexOf(0x0a);
    while (newlineIndex !== -1) {
      if (newlineIndex > this.#maxLineBytes) {
        this.#failLineTooLong();
        return;
      }

      let line = this.#stdoutBuffer.subarray(0, newlineIndex);
      this.#stdoutBuffer = this.#stdoutBuffer.subarray(newlineIndex + 1);
      if (line.at(-1) === 0x0d) {
        line = line.subarray(0, -1);
      }
      if (line.length > 0) {
        this.#receiveLine(line.toString("utf8"));
        if (this.#fatalError !== undefined) {
          return;
        }
      }
      newlineIndex = this.#stdoutBuffer.indexOf(0x0a);
    }

    if (this.#stdoutBuffer.length > this.#maxLineBytes) {
      this.#failLineTooLong();
    }
  }

  #receiveLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.#fail(new JsonlRpcProtocolError("MALFORMED_JSON", "Received malformed JSONL"));
      return;
    }

    if (!isJsonObject(message)) {
      this.#fail(new JsonlRpcProtocolError("INVALID_MESSAGE", "Received invalid JSONL-RPC message"));
      return;
    }
    if (typeof message.method === "string") {
      return;
    }
    if (typeof message.id !== "number" || !Number.isSafeInteger(message.id)) {
      this.#fail(new JsonlRpcProtocolError("INVALID_MESSAGE", "Response is missing a numeric id"));
      return;
    }

    const pending = this.#pending.get(message.id);
    if (pending === undefined) {
      return;
    }
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);

    const hasResult = Object.hasOwn(message, "result");
    const hasError = Object.hasOwn(message, "error");
    if (hasResult === hasError) {
      pending.reject(
        new JsonlRpcProtocolError("INVALID_MESSAGE", "Response must contain result or error"),
      );
      return;
    }
    if (hasResult) {
      pending.resolve(message.result);
      return;
    }

    if (
      !isJsonObject(message.error) ||
      typeof message.error.code !== "number" ||
      typeof message.error.message !== "string"
    ) {
      pending.reject(new JsonlRpcProtocolError("INVALID_MESSAGE", "Response error is invalid"));
      return;
    }
    pending.reject(
      new JsonlRpcRemoteError(message.error.code, message.error.message, message.error.data),
    );
  }

  #handleClose(code: number | null): void {
    this.#exited = true;
    this.#resolveExit();
    if (!this.#closed && this.#fatalError === undefined) {
      const diagnosticReason = this.#stderrPresent ? "STDERR_PRESENT" : "PROCESS_EXITED";
      this.#fail(
        new JsonlRpcProcessError(
          "Codex App Server process exited unexpectedly",
          code,
          diagnosticReason,
        ),
      );
    }
  }

  #failLineTooLong(): void {
    this.#fail(new JsonlRpcProtocolError("LINE_TOO_LONG", "JSONL-RPC line exceeds the byte limit"));
  }

  #fail(error: Error): void {
    if (this.#fatalError !== undefined) {
      return;
    }
    this.#fatalError = error;
    this.#rejectPending(error);
    if (!this.#exited) {
      this.#child.kill();
    }
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatePositiveInteger(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}
