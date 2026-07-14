import assert from "node:assert/strict";
import test from "node:test";

import {
  CodexLocatorError,
  locateCodex,
  type LocatorDependencies,
} from "../../src/platform/codex-locator.js";

type FakeOptions = {
  platform?: "darwin" | "win32";
  arch?: "x64" | "arm64";
  env?: Record<string, string | undefined>;
  homeDirectory?: string;
  files?: Record<string, number | "directory">;
  whereOutput?: string;
};

function fakeDependencies(options: FakeOptions = {}) {
  const calls: Array<{ file: string; args: readonly string[] }> = [];
  const files = options.files ?? {};
  const deps: LocatorDependencies = {
    platform: options.platform ?? "darwin",
    arch: options.arch ?? "x64",
    env: options.env ?? {},
    homeDirectory: options.homeDirectory ?? "/Users/tester",
    async stat(path) {
      const entry = files[path];
      if (entry === undefined) {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      }
      return {
        isFile: () => entry !== "directory",
        mode: entry === "directory" ? 0o755 : entry,
      };
    },
    async execFile(file, args) {
      calls.push({ file, args });
      if (options.whereOutput === undefined) {
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      }
      return { stdout: options.whereOutput };
    },
  };
  return { deps, calls };
}

async function assertNotFound(promise: Promise<string>): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) =>
      error instanceof CodexLocatorError && error.code === "CODEX_NOT_FOUND",
  );
}

test("explicit executable wins without invoking a process locator", async () => {
  const executable = "/Applications/Codex CLI/codex";
  const { deps, calls } = fakeDependencies({ files: { [executable]: 0o755 } });

  assert.equal(await locateCodex(executable, deps), executable);
  assert.deepEqual(calls, []);
});

test("invalid explicit path does not fall back to automatic candidates", async () => {
  const automatic = "/usr/local/bin/codex";
  const { deps } = fakeDependencies({
    env: { PATH: "/usr/local/bin" },
    files: { [automatic]: 0o755 },
  });

  await assertNotFound(locateCodex("/missing/codex", deps));
});

test("rejects a directory as an explicit executable", async () => {
  const directory = "/Applications/Codex";
  const { deps } = fakeDependencies({ files: { [directory]: "directory" } });

  await assertNotFound(locateCodex(directory, deps));
});

test("rejects a non-executable macOS file", async () => {
  const file = "/Applications/Codex/codex";
  const { deps } = fakeDependencies({ files: { [file]: 0o644 } });

  await assertNotFound(locateCodex(file, deps));
});

test("keeps spaces and shell metacharacters out of subprocess calls", async () => {
  const executable = "/Applications/Codex CLI/codex; open Calculator";
  const { deps, calls } = fakeDependencies({ files: { [executable]: 0o755 } });

  assert.equal(await locateCodex(executable, deps), executable);
  assert.deepEqual(calls, []);
});

test("finds Codex on the macOS PATH", async () => {
  const executable = "/Users/tester/tools/codex";
  const { deps } = fakeDependencies({
    env: { PATH: "/usr/bin:/Users/tester/tools" },
    files: { [executable]: 0o755 },
  });

  assert.equal(await locateCodex("", deps), executable);
});

for (const executable of [
  "/Users/tester/.local/bin/codex",
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex",
]) {
  test(`finds common macOS executable ${executable}`, async () => {
    const { deps } = fakeDependencies({ files: { [executable]: 0o755 } });

    assert.equal(await locateCodex("", deps), executable);
  });
}

test("normalizes an explicit absolute path", async () => {
  const normalized = "/opt/homebrew/bin/codex";
  const { deps } = fakeDependencies({ files: { [normalized]: 0o755 } });

  assert.equal(await locateCodex("/opt/homebrew/bin/../bin/codex", deps), normalized);
});

test("rejects a relative explicit path", async () => {
  const { deps } = fakeDependencies({ files: { codex: 0o755 } });

  await assertNotFound(locateCodex("codex", deps));
});

test("uses where.exe with fixed arguments and accepts a native Windows result", async () => {
  const executable = "C:\\Program Files\\OpenAI\\Codex\\codex.exe";
  const { deps, calls } = fakeDependencies({
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    whereOutput: `C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd\r\n${executable}\r\n`,
    files: {
      "C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd": 0o755,
      [executable]: 0o755,
    },
  });

  assert.equal(await locateCodex("", deps), executable);
  assert.deepEqual(calls, [
    { file: "C:\\Windows\\System32\\where.exe", args: ["codex"] },
  ]);
});

test("finds the official Windows standalone install path", async () => {
  const executable =
    "C:\\Users\\Example User\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe";
  const { deps } = fakeDependencies({
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\Example User\\AppData\\Local" },
    files: { [executable]: 0o755 },
  });

  assert.equal(await locateCodex("", deps), executable);
});

test("resolves the native executable inside a Windows npm global install", async () => {
  const executable =
    "C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe";
  const { deps } = fakeDependencies({
    platform: "win32",
    env: { APPDATA: "C:\\Users\\tester\\AppData\\Roaming" },
    files: { [executable]: 0o755 },
  });

  assert.equal(await locateCodex("", deps), executable);
});

test("rejects Windows command shims because they require a shell", async () => {
  const shim = "C:\\Users\\tester\\AppData\\Roaming\\npm\\codex.cmd";
  const { deps } = fakeDependencies({
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    whereOutput: `${shim}\r\n`,
    files: { [shim]: 0o755 },
  });

  await assertNotFound(locateCodex("", deps));
});

test("reports CODEX_NOT_FOUND when no candidate is executable", async () => {
  const { deps } = fakeDependencies();

  await assertNotFound(locateCodex("", deps));
});
