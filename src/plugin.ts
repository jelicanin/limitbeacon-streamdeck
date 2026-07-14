import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";

import streamDeck from "@elgato/streamdeck";

import {
  CodexLimitsAction,
  CodexLimitsController,
} from "./actions/codex-limits-action.js";
import { normalizeSettings } from "./domain/settings.js";
import { locateCodex, type LocatorDependencies } from "./platform/codex-locator.js";
import { CodexAppServerProvider } from "./providers/codex-app-server-provider.js";
import { JsonlRpcClient } from "./providers/jsonl-rpc-client.js";
import { UsageService } from "./services/usage-service.js";

let settings = normalizeSettings(undefined);
const locatorDependencies = nodeLocatorDependencies();
const provider = new CodexAppServerProvider({
  createClient: async () => {
    const executable = await locateCodex(settings.codexExecutable, locatorDependencies);
    return JsonlRpcClient.start({
      executable,
      args: ["app-server"],
      initializeParams: {
        clientInfo: {
          name: "limitbeacon",
          title: "LimitBeacon",
          version: "0.1.0",
        },
      },
    });
  },
});
const usageService = new UsageService(provider, {
  refreshIntervalMs: settings.refreshMinutes * 60_000,
});
const controller = new CodexLimitsController(usageService);

streamDeck.settings.onDidReceiveGlobalSettings((event) => {
  void applySettings(event.settings);
});
streamDeck.actions.registerAction(
  new CodexLimitsAction(controller, (payload) => streamDeck.ui.sendToPropertyInspector(payload)),
);
await streamDeck.connect();
await applySettings(await streamDeck.settings.getGlobalSettings());

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

async function shutdown(): Promise<void> {
  await usageService.close();
  process.exit(0);
}

async function applySettings(rawSettings: unknown): Promise<void> {
  const next = normalizeSettings(rawSettings);
  const executableChanged = next.codexExecutable !== settings.codexExecutable;
  settings = next;
  usageService.setRefreshInterval(next.refreshMinutes * 60_000);

  if (executableChanged) {
    const active = usageService.getState().status !== "idle";
    await provider.reset();
    if (active) {
      void usageService.refresh().catch(() => usageService.refresh().catch(() => undefined));
    }
  }
}

function nodeLocatorDependencies(): LocatorDependencies {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    throw new Error("LimitBeacon supports macOS and Windows");
  }
  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error("LimitBeacon supports x64 and arm64 processors");
  }

  return {
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    homeDirectory: homedir(),
    stat,
    execFile: (file, args) =>
      new Promise((resolve, reject) => {
        execFile(file, [...args], { shell: false, windowsHide: true }, (error, stdout) => {
          if (error) reject(error);
          else resolve({ stdout });
        });
      }),
  };
}
