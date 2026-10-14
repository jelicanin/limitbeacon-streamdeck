import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServerProvider } from "../../src/providers/codex-app-server-provider.js";
import { UsageService } from "../../src/services/usage-service.js";
import { CodexLimitsController } from "../../src/actions/codex-limits-action.js";
import { LimitBrowserController } from "../../src/actions/limit-browser-action.js";

test("multiple surfaces share reads, preserve group identity through failures, and restore saved selection", async (t) => {
  const limits = (used: number) => ({ primary: { usedPercent: used, windowDurationMins: 15, resetsAt: null } });
  let response: unknown = { rateLimitsByLimitId: {
    codex: limits(10), research: { ...limits(70), limitName: "Research <safe>" },
  }};
  let calls = 0;
  const provider = new CodexAppServerProvider({ createClient: async () => ({
    request: async <T>(method: string) => {
      assert.equal(method, "account/rateLimits/read");
      calls += 1;
      if (response instanceof Error) throw response;
      return response as T;
    },
    close: async () => {},
  }) });
  const service = new UsageService(provider);
  t.after(() => service.close());
  const keys = new CodexLimitsController(service);
  const dials = new LimitBrowserController(service);
  const images = new Map<string, string>();
  const key = (id: string) => ({ id, setImage: async (image: string) => { images.set(id, image); }, showOk: async () => {}, showAlert: async () => {} });
  let saved: Record<string, unknown> = {};
  const dial = {
    id: "dial", setFeedback: async (data: Record<string, unknown>) => { images.set("dial", String(data.canvas)); },
    setSettings: async (settings: Record<string, unknown>) => { saved = settings; }, showAlert: async () => {},
  };
  const svg = (id: string) => decodeURIComponent(images.get(id)?.split(",").slice(1).join(",") ?? "");
  keys.appear(key("default"), {});
  keys.appear(key("research"), {limitGroupId: "research"});
  dials.appear(dial, {limitGroupId: "research"});
  await service.refresh();
  assert.equal(calls, 1);
  assert.match(svg("default"), />90%</u);
  assert.match(svg("research"), />30%</u);
  assert.match(svg("dial"), /Research &lt;safe&gt;/u);
  assert.doesNotMatch(svg("research"), /<safe>/u);
  assert.match(svg("dial"), /15M/u);
  await dials.touch("dial");
  assert.equal(saved.limitGroupId, "research");
  dials.disappear("dial");
  dials.appear(dial, saved);
  assert.match(svg("dial"), />70%</u);
  assert.equal(calls, 1);

  response = {rateLimitsByLimitId: {codex: limits(20), research: {...limits(700), limitName: "Research <safe>"}}};
  await service.refresh();
  assert.match(svg("default"), />80%</u);
  assert.match(svg("research"), />30%</u);
  assert.match(svg("research"), />STALE</u);
  response = {rateLimitsByLimitId: {codex: limits(25)}};
  await service.refresh();
  assert.match(svg("research"), /Group unavailable/u);
  assert.match(svg("dial"), /Group unavailable/u);
  response = {rateLimitsByLimitId: {codex: limits(25), research: {...limits(60), limitName: "Research <safe>"}}};
  await service.refresh();
  assert.match(svg("research"), />40%</u);
  assert.match(svg("dial"), />60%</u);
  assert.doesNotMatch(svg("research"), />STALE</u);
  response = new Error("Network unavailable");
  await assert.rejects(service.refresh());
  assert.match(svg("research"), />40%</u);
  assert.match(svg("research"), />STALE</u);
  assert.match(svg("dial"), />60%</u);
  assert.equal(calls, 5);
});
