import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_APPEARANCE, normalizeAppearance, normalizeSettings, validHexColor } from "../../src/domain/settings.js";

test("appearance accepts only six-digit hex colours and safely falls back", () => {
  assert.equal(validHexColor("#a1b2c3"), true);
  for (const value of ["#fff", "red", "#123456\" onload=\"x", "#12345678", null, 123]) assert.equal(validHexColor(value), false);
  assert.deepEqual(normalizeAppearance({background: "#a1b2c3", text: "url(x)", healthy: "<script>", outline: "true", outlineColor: "#fff"}),
    {...DEFAULT_APPEARANCE, background: "#A1B2C3"});
  assert.deepEqual(normalizeAppearance(null), DEFAULT_APPEARANCE);
});

const defaults = {
  limitGroupId: "",
  window: "automatic",
  basis: "remaining",
  displayStyle: "bars",
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
      limitGroupId: "",
      window: "automatic",
      basis: "used",
      displayStyle: "rings",
      refreshMinutes: 15,
      warningThreshold: 40,
      criticalThreshold: 20,
      resetStyle: "local-time",
      codexExecutable: "/Applications/Codex CLI/codex",
      ignoredFutureSetting: "safe to ignore",
    }),
    {
      limitGroupId: "",
      window: "automatic",
      basis: "used",
      displayStyle: "rings",
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
  ["window", "weekly"],
  ["displayStyle", "radar"],
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
