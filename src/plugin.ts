import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";

import streamDeck from "@elgato/streamdeck";
import packageInfo from "../package.json" with { type: "json" };

import {
  CodexLimitsAction,
  CodexLimitsController,
} from "./actions/codex-limits-action.js";
import {
  LimitBrowserAction,
  LimitBrowserController,
} from "./actions/limit-browser-action.js";
import {
  ActivityStatsAction,
  CreditsSpendAction,
  DailyTokensAction,
  SpecializedDialController,
} from "./actions/specialized-dials-action.js";
import { normalizeSettings } from "./domain/settings.js";
import { readConnectionSettings, type ConnectionSettings } from "./domain/connection-settings.js";
import { locateCodex, type LocatorDependencies } from "./platform/codex-locator.js";
import { CodexAppServerProvider } from "./providers/codex-app-server-provider.js";
import { JsonlRpcClient } from "./providers/jsonl-rpc-client.js";
import { UsageService } from "./services/usage-service.js";

let settings: ConnectionSettings = normalizeSettings(undefined);
const locatorDependencies = nodeLocatorDependencies();
const provider = new CodexAppServerProvider({
  createClient: async (onNotification) => {
    const executable = await locateCodex(settings.codexExecutable, locatorDependencies);
    return JsonlRpcClient.start({
      executable,
      args: ["app-server"],
      onNotification,
      initializeParams: {
        clientInfo: {
          name: "limitbeacon",
          title: "LimitBeacon",
          version: packageInfo.version,
        },
      },
    });
  },
});
const usageService = new UsageService(provider, {
  refreshIntervalMs: settings.refreshMinutes * 60_000,
});
const controller = new CodexLimitsController(usageService);
const limitBrowserController = new LimitBrowserController(usageService);
const dailyTokensController = new SpecializedDialController(usageService, "daily");
const creditsSpendController = new SpecializedDialController(usageService, "credits");
const activityStatsController = new SpecializedDialController(usageService, "activity");

streamDeck.settings.onDidReceiveGlobalSettings((event) => {
  void applySettings(event.settings).catch(() => {
    streamDeck.logger.warn("Could not apply connection settings. Retry the connection.");
  });
});
streamDeck.actions.registerAction(
  new CodexLimitsAction(controller, (payload) => streamDeck.ui.sendToPropertyInspector(payload)),
);
streamDeck.actions.registerAction(new LimitBrowserAction(
  limitBrowserController, (payload) => streamDeck.ui.sendToPropertyInspector(payload),
));
streamDeck.actions.registerAction(new DailyTokensAction(
  dailyTokensController, (payload) => streamDeck.ui.sendToPropertyInspector(payload),
));
streamDeck.actions.registerAction(new CreditsSpendAction(
  creditsSpendController, (payload) => streamDeck.ui.sendToPropertyInspector(payload),
));
streamDeck.actions.registerAction(new ActivityStatsAction(
  activityStatsController, (payload) => streamDeck.ui.sendToPropertyInspector(payload),
));
await streamDeck.connect();
await applySettings(await streamDeck.settings.getGlobalSettings());

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

async function shutdown(): Promise<void> {
  await usageService.close();
  process.exit(0);
}

async function applySettings(rawSettings: unknown): Promise<void> {
  const { settings: next, valid } = readConnectionSettings(rawSettings, settings);
  if (!valid) {
    streamDeck.logger.warn("Invalid connection settings were ignored; keeping the last valid settings.");
    return;
  }
  const executableChanged = next.codexExecutable !== settings.codexExecutable;
  settings = next;
  usageService.setRefreshInterval(next.refreshMinutes * 60_000);

  if (executableChanged) {
    const rateLimitsActive = usageService.getState().status !== "idle";
    const tokenUsageActive = usageService.getTokenUsageState().status !== "idle";
    await provider.reset();
    if (rateLimitsActive) {
      void usageService.refresh().catch(() => usageService.refresh().catch(() => undefined));
    }
    if (tokenUsageActive) {
      void usageService.refreshTokenUsage().catch(() =>
        usageService.refreshTokenUsage().catch(() => undefined)
      );
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
