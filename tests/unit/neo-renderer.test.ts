import assert from "node:assert/strict";
import test from "node:test";
import { normalizeNeoSettings } from "../../src/domain/neo-settings.js";
import { mapLimitGroups } from "../../src/domain/limit-groups.js";
import { renderNeo } from "../../src/render/neo-renderer.js";
import type { UsageServiceState } from "../../src/services/usage-service.js";

const collection = mapLimitGroups(
  {
    rateLimitsByLimitId: {
      codex: {
        primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 3600 },
        secondary: null,
      },
      other: {
        limitName: "<Team & Co>",
        primary: { usedPercent: 70, windowDurationMins: 15, resetsAt: 600 },
        secondary: {
          usedPercent: 40,
          windowDurationMins: 10080,
          resetsAt: null,
        },
      },
    },
  },
  1000,
);
const state: UsageServiceState = {
  status: "ready",
  error: null,
  snapshot: null,
  collection,
};

test("Neo respects explicit included-usage denial even when quota remains", () => {
  const denied = structuredClone(state);
  denied.collection!.groups[0]!.snapshot!.accountHealth.ordinaryUsageAllowed = false;
  const svg = renderNeo(denied, normalizeNeoSettings({}), 0);
  assert.match(svg, /Usage blocked/);
  assert.match(svg, /Check Codex/);
  assert.doesNotMatch(svg, /80%/);
});

test("Neo keeps each selected group's percent, label and real duration on its 232x50 canvas", () => {
  const svg = renderNeo(
    state,
    { limitGroupId: "other", window: "automatic" },
    0,
  );
  assert.match(svg, /viewBox="0 0 232 50"/);
  assert.match(svg, /30%/);
  assert.match(svg, /15M/);
  assert.match(svg, /RESET 10m/);
  assert.match(svg, /&lt;Team &amp; Co&gt;/);
  assert.doesNotMatch(svg, /80%|<Team/);
});

test("Neo explicit window selection never substitutes an available different window", () => {
  assert.match(
    renderNeo(state, { limitGroupId: "other", window: "secondary" }, 0),
    /60%/,
  );
  const missing = renderNeo(
    state,
    { limitGroupId: "codex", window: "secondary" },
    0,
  );
  assert.match(missing, /Window unavailable/);
  assert.doesNotMatch(missing, /80%|0%/);
  assert.match(
    renderNeo(state, { limitGroupId: "gone", window: "automatic" }, 0),
    /Group unavailable/,
  );
});

test("Neo marks cached readings stale and distinguishes unavailable from zero remaining", () => {
  const cached = structuredClone(state);
  cached.collection!.groups.find((g) => g.id === "other")!.snapshot!.stale =
    true;
  const svg = renderNeo(
    cached,
    { limitGroupId: "other", window: "automatic" },
    0,
  );
  assert.match(svg, /STALE/);
  assert.match(svg, /30%/);
  const exhausted = structuredClone(state);
  exhausted.collection!.groups[0]!.snapshot!.fiveHour!.remainingPercent = 0;
  assert.match(renderNeo(exhausted, normalizeNeoSettings({}), 0), /0%/);
  assert.match(
    renderNeo(
      { status: "loading", error: null, snapshot: null },
      normalizeNeoSettings({}),
    ),
    /Codex is starting/,
  );
});

test("Neo settings preserve only supported group and window selections", () => {
  assert.deepEqual(
    normalizeNeoSettings({
      limitGroupId: "other",
      window: "secondary",
      activeIndex: 5,
    }),
    { limitGroupId: "other", window: "secondary" },
  );
  assert.deepEqual(normalizeNeoSettings({ limitGroupId: 7, window: "bad" }), {
    limitGroupId: "",
    window: "automatic",
  });
});
