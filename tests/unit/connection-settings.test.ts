import assert from "node:assert/strict";
import test from "node:test";

import { readConnectionSettings } from "../../src/domain/connection-settings.js";

const previous = { refreshMinutes: 15, codexExecutable: "/tools/codex" };

test("invalid saved connection settings retain the last valid connection", () => {
  for (const raw of [[], "invalid", { refreshMinutes: 0 }, { codexExecutable: 42 }]) {
    assert.deepEqual(readConnectionSettings(raw, previous), {
      settings: previous,
      valid: false,
    });
  }
});

test("legacy key settings cannot invalidate global connection preferences", () => {
  assert.deepEqual(readConnectionSettings({
    refreshMinutes: 30,
    codexExecutable: "/other/codex",
    warningThreshold: "invalid legacy value",
  }, previous), {
    settings: { refreshMinutes: 30, codexExecutable: "/other/codex" },
    valid: true,
  });
});

test("cleared global settings restore automatic discovery and default cadence", () => {
  assert.deepEqual(readConnectionSettings(undefined, previous), {
    settings: { refreshMinutes: 5, codexExecutable: "" },
    valid: true,
  });
});
