import { closeSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "standard";
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const delayed = [];
if (mode === "uncooperative" || mode === "broken-stdin") {
  // A failsafe also bounds test cleanup when the production close implementation is broken.
  setTimeout(() => process.exit(0), 2000);
}
if (mode === "uncooperative") process.on("SIGTERM", () => {});
let initialized = false;
let initializeParams = null;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

lines.on("line", (line) => {
  const message = JSON.parse(line);

  if (message.method === "initialize") {
    if (mode === "stderr-exit") {
      process.stderr.write("Bearer super-secret-token ".repeat(100));
      setTimeout(() => process.exit(19), 5);
      return;
    }
    initializeParams = message.params;
    send({
      id: message.id,
      result: { userAgent: "fake-app-server", platformFamily: "test", platformOs: "test" },
    });
    return;
  }

  if (message.method === "initialized" && message.id === undefined) {
    initialized = true;
    return;
  }

  if (!initialized) {
    send({ id: message.id, error: { code: -32_002, message: "Not initialized" } });
    return;
  }

  switch (message.method) {
    case "handshake/status":
      send({
        id: message.id,
        result: {
          initialized,
          clientName: initializeParams?.clientInfo?.name ?? null,
        },
      });
      break;
    case "process/id":
      send({ id: message.id, result: process.pid });
      break;
    case "account/rateLimits/read":
      if (mode === "malformed-limits") {
        process.stdout.write('{"id":\n');
      } else {
        send({
          id: message.id,
          result: JSON.parse(readFileSync(new URL("./rate-limits/direct.json", import.meta.url), "utf8")),
        });
      }
      break;
    case "close-stdin":
      lines.close();
      process.stdin.once("close", () => {
        // Close libuv's stream handle first, including its Windows duplicate,
        // then the original stdio descriptor when the runtime leaves it open.
        try {
          closeSync(0);
        } catch (error) {
          if (error.code !== "EBADF") throw error;
        }
        send({ id: message.id, result: true });
      });
      process.stdin.destroy();
      break;
    case "echo":
      send({ id: message.id, result: message.params });
      break;
    case "delayed":
      delayed.push(message);
      if (delayed.length === 2) {
        for (const pending of delayed.reverse()) {
          send({
            id: pending.id,
            result: { value: pending.params.value, requestId: pending.id },
          });
        }
      }
      break;
    case "notification-first":
      send({ method: "account/rateLimits/updated", params: { fake: true } });
      setTimeout(() => send({ id: message.id, result: { value: "response" } }), 5);
      break;
    case "malformed":
      process.stdout.write('{"id":\n');
      break;
    case "remote-error":
      send({
        id: message.id,
        error: {
          code: -32_000,
          message: "Fake service failure",
          data: { retryable: false },
        },
      });
      break;
    case "late":
      setTimeout(() => send({ id: message.id, result: message.params }), 60);
      break;
    case "hang":
      break;
    case "crash-with-pending":
      setTimeout(() => process.exit(17), 10);
      break;
    case "long-line":
      process.stdout.write(`${"x".repeat(300)}\n`);
      break;
    default:
      send({ id: message.id, error: { code: -32_601, message: "Unknown method" } });
  }
});

lines.on("close", () => {
  if (mode !== "uncooperative" && mode !== "broken-stdin") process.exit(0);
});
