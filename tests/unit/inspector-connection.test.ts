import assert from "node:assert/strict";
import test from "node:test";
import { InspectorConnection, isInspectorRefreshCommand } from "../../src/ui/inspector-connection.js";
import { UsageService } from "../../src/services/usage-service.js";
import { CodexProviderError } from "../../src/providers/codex-app-server-provider.js";
import { CodexLocatorError } from "../../src/platform/codex-locator.js";
import type { InspectorStatusId } from "../../src/ui/inspector-model.js";

function tokenService() {
  let failure: Error | null = null;
  const service = new UsageService({
    read: async () => { throw new Error("Wrong data channel"); },
    readTokenUsage: async () => {
      if (failure !== null) throw failure;
      return {
        capturedAt: 1, stale: false, daily: [], summary: {
          currentStreakDays: null, lifetimeTokens: null, longestRunningTurnSec: null,
          longestStreakDays: null, peakDailyTokens: null,
        },
      };
    },
    close: async () => {},
  }, {timers: {setInterval: () => 1, clearInterval: () => {}}});
  return {service, fail: (error: Error) => { failure = error; }};
}

test("token inspectors receive initial, fresh and stale state from the token channel", async (t) => {
  const {service, fail} = tokenService();
  t.after(() => service.close());
  const connection = new InspectorConnection(subscriber => service.subscribeTokenUsage(subscriber));
  const statuses: InspectorStatusId[] = [];
  connection.appear("daily", async ({status}) => { statuses.push(status); });
  assert.equal(statuses[0], "starting");
  await service.refreshTokenUsage();
  assert.equal(statuses.at(-1), "connected");
  fail(new Error("Offline"));
  await assert.rejects(service.refreshTokenUsage(), /Offline/);
  assert.equal(statuses.at(-1), "stale");
  assert.equal(service.getState().status, "idle");
});

test("changing inspector disconnects the old subscriber and late disappearance preserves the new one", async (t) => {
  const {service} = tokenService();
  t.after(() => service.close());
  const connection = new InspectorConnection(subscriber => service.subscribeTokenUsage(subscriber));
  const oldStatuses: InspectorStatusId[] = [];
  const currentStatuses: InspectorStatusId[] = [];
  connection.appear("first", async ({status}) => { oldStatuses.push(status); });
  connection.appear("second", async ({status}) => { currentStatuses.push(status); });
  const oldCount = oldStatuses.length;
  connection.disappear("first");
  await service.refreshTokenUsage();
  assert.equal(oldStatuses.length, oldCount);
  assert.equal(currentStatuses.at(-1), "connected");
  connection.disappear("second");
  const currentCount = currentStatuses.length;
  await service.refreshTokenUsage();
  assert.equal(currentStatuses.length, currentCount);
});

for (const [error, expected] of [
  [new CodexLocatorError("Missing"), "codex-missing"],
  [new CodexProviderError("SIGN_IN_REQUIRED", "Login"), "sign-in-required"],
  [new CodexProviderError("CODEX_INCOMPATIBLE", "Unsupported"), "incompatible"],
  [new Error("Offline"), "error"],
] as const) {
  test(`inspector gives ${expected} recovery for a failed first read`, async (t) => {
    const {service, fail} = tokenService();
    t.after(() => service.close());
    fail(error);
    const connection = new InspectorConnection(subscriber => service.subscribeTokenUsage(subscriber));
    const statuses: InspectorStatusId[] = [];
    connection.appear("daily", async ({status}) => { statuses.push(status); });
    await assert.rejects(service.refreshTokenUsage());
    assert.equal(statuses.at(-1), expected);
  });
}

test("inspector sender rejection cannot poison a successful provider read", async (t) => {
  const {service} = tokenService();
  t.after(() => service.close());
  const connection = new InspectorConnection(subscriber => service.subscribeTokenUsage(subscriber));
  const sent: InspectorStatusId[] = [];
  connection.appear("daily", async ({status}) => { sent.push(status); throw new Error("Inspector closed"); });
  assert.equal((await service.refreshTokenUsage()).status, "ready");
  assert.equal(sent.at(-1), "connected");
});

test("inspector accepts only the refresh command", () => {
  assert.equal(isInspectorRefreshCommand({command: "refresh"}), true);
  for (const value of [null, [], "refresh", {}, {command: "other"}]) {
    assert.equal(isInspectorRefreshCommand(value), false);
  }
});
