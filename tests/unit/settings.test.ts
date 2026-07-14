import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSettings } from "../../src/domain/settings.js";

const defaults = {
  basis: "remaining",
  refreshMinutes: 5,
  warningThreshold: 35,
  criticalThreshold: 15,
  resetStyle: "countdown",
  codexExecutable: "",
};

test("returns complete defaults for missing settings", () => {
  assert.deepEqual(normalizeSettings(undefined), defaults);
  assert.deepEqual(normalizeSettings(null), defaults);
});

test("merges valid partial settings over defaults", () => {
  assert.deepEqual(
    normalizeSettings({
      basis: "used",
      refreshMinutes: 15,
      warningThreshold: 40,
      criticalThreshold: 20,
      resetStyle: "local-time",
      codexExecutable: "/Applications/Codex CLI/codex",
      ignoredFutureSetting: "safe to ignore",
    }),
    {
      basis: "used",
      refreshMinutes: 15,
      warningThreshold: 40,
      criticalThreshold: 20,
      resetStyle: "local-time",
      codexExecutable: "/Applications/Codex CLI/codex",
    },
  );
});

test("rejects thresholds in an impossible order", () => {
  assert.throws(
    () => normalizeSettings({ warningThreshold: 15, criticalThreshold: 35 }),
    /criticalThreshold must be less than or equal to warningThreshold/,
  );
});

for (const [field, value] of [
  ["basis", "available"],
  ["refreshMinutes", 0],
  ["refreshMinutes", 1.5],
  ["refreshMinutes", 61],
  ["warningThreshold", -1],
  ["warningThreshold", 101],
  ["warningThreshold", "35"],
  ["criticalThreshold", Number.NaN],
  ["resetStyle", "date"],
  ["codexExecutable", 42],
] as const) {
  test(`rejects invalid ${field}`, () => {
    assert.throws(() => normalizeSettings({ [field]: value }), new RegExp(field));
  });
}

test("rejects non-object settings containers", () => {
  assert.throws(() => normalizeSettings([]), /settings must be an object/);
  assert.throws(() => normalizeSettings("remaining"), /settings must be an object/);
});
