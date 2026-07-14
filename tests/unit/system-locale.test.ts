import assert from "node:assert/strict";
import test from "node:test";

import { resolveSystemLocale } from "../../src/platform/system-locale.js";

test("reads the macOS region locale", () => {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const locale = resolveSystemLocale("darwin", (file, args) => {
    calls.push({ file, args });
    return "hr_HR\n";
  });

  assert.equal(locale, "hr-HR");
  assert.deepEqual(calls, [{
    file: "/usr/bin/defaults",
    args: ["read", "-g", "AppleLocale"],
  }]);
});

test("preserves macOS region conventions when the language-region pair is unsupported", () => {
  const locale = resolveSystemLocale("darwin", () => "en_HR\n");

  assert.equal(locale, "hr-HR");
});

test("reads the Windows user region locale", () => {
  const locale = resolveSystemLocale("win32", () => `
HKEY_CURRENT_USER\\Control Panel\\International
    LocaleName    REG_SZ    de-DE
  `);

  assert.equal(locale, "de-DE");
});

test("falls back safely when the platform locale cannot be read", () => {
  assert.equal(resolveSystemLocale("darwin", () => { throw new Error("unavailable"); }), undefined);
  assert.equal(resolveSystemLocale("linux", () => "hr_HR"), undefined);
});
