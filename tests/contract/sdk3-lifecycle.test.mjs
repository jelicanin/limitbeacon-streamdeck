import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { build } from "esbuild";
const { WebSocketServer } = createRequire(
  import.meta.resolve("@elgato/streamdeck"),
)("ws");
const root = fileURLToPath(new URL("../../", import.meta.url));

// Real entrypoint, SDK, provider, service and controllers. Only Codex discovery/process
// boundaries are replaced; no actual Codex executable, credentials or account is accessed.
test(
  "SDK 3 applies requested initial settings, PI changes and local dial writes without event echoes; Neo reappears",
  { timeout: 20000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "limitbeacon-sdk3-"));
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    let child;
    let stderr = "";
    const messages = [];
    let socket;
    const waiters = new Set();
    const waitFor = (predicate, fromIndex = 0) => {
      const found = messages.slice(fromIndex).find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(
            new Error(
              `SDK message timeout; received=${messages.map((m) => m.event + ":" + (m.context ?? "")).join(",")}; stderr=${stderr}`,
            ),
          );
        }, 5000);
        const check = (message) => {
          if (messages.indexOf(message) >= fromIndex && predicate(message)) {
            clearTimeout(timer);
            waiters.delete(check);
            resolve(message);
          }
        };
        waiters.add(check);
      });
    };
    server.on("connection", (client) => {
      socket = client;
      client.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        messages.push(msg);
        if (msg.event === "getGlobalSettings") {
          assert.equal(typeof msg.id, "string");
          client.send(
            JSON.stringify({
              event: "didReceiveGlobalSettings",
              id: msg.id,
              payload: {
                settings: {
                  codexExecutable: "/fixture/initial",
                  refreshMinutes: 5,
                },
              },
            }),
          );
        }
        for (const check of waiters) check(msg);
      });
    });
    try {
      await writeFile(
        join(dir, "manifest.json"),
        await readFile(
          join(root, "com.jelicanin.limitbeacon.sdPlugin/manifest.json"),
        ),
      );
      await build({
        entryPoints: [join(root, "src/plugin.ts")],
        outfile: join(dir, "plugin.mjs"),
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node24",
        define: { "process.platform": '"darwin"' },
        banner: {
          js: 'import {createRequire as __cr} from "node:module"; const require=__cr(import.meta.url);',
        },
        plugins: [
          {
            name: "codex-process-fixture",
            setup(b) {
              b.onLoad({ filter: /[/\\]codex-locator\.ts$/ }, () => ({
                loader: "ts",
                contents: `
          export class CodexLocatorError extends Error {}
          export async function locateCodex(override) {
            if (!override.startsWith('/fixture/')) throw new CodexLocatorError('No fixture override applied');
            return override;
          }`,
              }));
              b.onLoad({ filter: /[/\\]jsonl-rpc-client\.ts$/ }, () => ({
                loader: "ts",
                contents: `
          export class JsonlRpcProcessError extends Error {}
          export class JsonlRpcProtocolError extends Error {}
          export class JsonlRpcRemoteError extends Error {}
          export class JsonlRpcClient {
            static async start({executable}) {
              return {close:async()=>{},request:async(method)=>{
                if(method!=='account/rateLimits/read') throw new Error('Unexpected fixture request');
                return {rateLimitsByLimitId:{codex:{primary:{usedPercent:executable.endsWith('initial')?20:60,windowDurationMins:300,resetsAt:null},secondary:null},
                  team:{limitName:'Team',primary:{usedPercent:70,windowDurationMins:15,resetsAt:null},secondary:null}}};
              }};
            }
          }`,
              }));
            },
          },
        ],
      });
      child = spawn(
        process.execPath,
        [
          join(dir, "plugin.mjs"),
          "-port",
          String(server.address().port),
          "-pluginUUID",
          "sdk-fixture",
          "-registerEvent",
          "registerPlugin",
          "-info",
          JSON.stringify({
            application: { version: "7.6.0", platform: "mac", language: "en" },
            plugin: { uuid: "com.jelicanin.limitbeacon", version: "1.3.0" },
            devices: [
              {
                id: "device",
                name: "Fixture",
                type: 7,
                size: { columns: 4, rows: 2 },
              },
            ],
          }),
        ],
        { cwd: dir, stdio: ["ignore", "ignore", "pipe"] },
      );
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      await waitFor((m) => m.event === "getGlobalSettings");
      const send = (event, action, context, payload = {}) =>
        socket.send(
          JSON.stringify({
            event,
            action: `com.jelicanin.limitbeacon.${action}`,
            context,
            device: "device",
            payload,
          }),
        );
      const appear = (action, context, controller, settings = {}) =>
        send("willAppear", action, context, {
          controller,
          settings,
          coordinates: { column: 0, row: 0 },
          isInMultiAction: false,
          state: 0,
        });
      const svg = (m) =>
        decodeURIComponent(m.payload?.canvas ?? m.payload?.image ?? "");
      appear("codex-limits", "key", "Keypad");
      await waitFor(
        (m) =>
          m.context === "key" &&
          m.event === "setImage" &&
          svg(m).includes("80%"),
      );
      appear("neo-limits", "neo", "Neo", { limitGroupId: "team" });
      await waitFor(
        (m) =>
          m.context === "neo" &&
          m.event === "setFeedback" &&
          svg(m).includes("30%"),
      );
      const layoutIndex = messages.findIndex(
        (m) => m.context === "neo" && m.event === "setFeedbackLayout",
      );
      assert.ok(
        layoutIndex >= 0 &&
          layoutIndex <
            messages.findIndex(
              (m) => m.context === "neo" && m.event === "setFeedback",
            ),
      );
      send("didReceiveSettings", "neo-limits", "neo", {
        controller: "Neo",
        settings: { limitGroupId: "gone", window: "automatic" },
      });
      await waitFor(
        (m) =>
          m.context === "neo" &&
          m.event === "setFeedback" &&
          svg(m).includes("Group unavailable"),
      );
      socket.send(
        JSON.stringify({
          event: "didReceiveGlobalSettings",
          payload: {
            settings: {
              codexExecutable: "/fixture/changed",
              refreshMinutes: 5,
            },
          },
        }),
      );
      await waitFor(
        (m) =>
          m.context === "key" &&
          m.event === "setImage" &&
          svg(m).includes("40%"),
      );
      appear("limit-browser", "dial", "Encoder", {
        limitGroupId: "team",
        basis: "remaining",
      });
      await waitFor(
        (m) =>
          m.context === "dial" &&
          m.event === "setFeedback" &&
          svg(m).includes("30%"),
      );
      send("touchTap", "limit-browser", "dial", {
        controller: "Encoder",
        tapPos: [10, 10],
        hold: false,
        settings: { limitGroupId: "team", basis: "remaining" },
      });
      const saved = await waitFor(
        (m) => m.context === "dial" && m.event === "setSettings",
      );
      assert.equal(saved.payload.limitGroupId, "team");
      assert.equal(saved.payload.basis, "used");
      // Do not send didReceiveSettings back: SDK 3 does not echo plugin writes.
      await waitFor(
        (m) =>
          m.context === "dial" &&
          m.event === "setFeedback" &&
          svg(m).includes("70%"),
      );
      send("willDisappear", "neo-limits", "neo", {
        controller: "Neo",
        settings: {},
      });
      const reappearanceIndex = messages.length;
      appear("neo-limits", "neo", "Neo", { limitGroupId: "team" });
      const replacementLayout = await waitFor(
        (m) => m.context === "neo" && m.event === "setFeedbackLayout",
        reappearanceIndex,
      );
      const replacementFeedback = await waitFor(
        (m) =>
          m.context === "neo" &&
          m.event === "setFeedback" &&
          svg(m).includes("30%"),
        reappearanceIndex,
      );
      assert.ok(
        messages.indexOf(replacementLayout) <
          messages.indexOf(replacementFeedback),
        "Reappearing Neo must send its new layout before its new feedback",
      );
      assert.equal(child.exitCode, null);
    } finally {
      if (child && child.exitCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill();
        await exited;
      }
      for (const client of server.clients) client.terminate();
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    }
  },
);
