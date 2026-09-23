import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const bundles = [
  fileURLToPath(new URL("../com.jelicanin.limitbeacon.sdPlugin/bin/plugin.js", import.meta.url)),
  fileURLToPath(new URL("../com.jelicanin.limitbeacon.sdPlugin/ui/index.js", import.meta.url)),
];

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function rebuild() {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/build.mjs"], {
      cwd: root,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Build exited with code ${code ?? "unknown"}`));
    });
  });
}

async function assertBundleStarts() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const child = spawn(
    process.execPath,
    [
      bundles[0],
      "-port",
      String(address.port),
      "-pluginUUID",
      "startup-smoke",
      "-registerEvent",
      "registerPlugin",
      "-info",
      "{}",
    ],
    { cwd: root, stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exit = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  const result = await Promise.race([
    exit,
    new Promise((resolve) => setTimeout(() => resolve("running"), 300)),
  ]);
  if (result === "running") {
    child.kill();
    await exit;
  }
  await new Promise((resolve) => server.close(resolve));
  assert.ok(
    result === "running" || result === 0,
    `Generated plugin crashed during startup:\n${stderr}`,
  );
}

await rebuild();
const before = await Promise.all(bundles.map(async (bundle) => digest(await readFile(bundle))));
await rebuild();
const after = await Promise.all(bundles.map(async (bundle) => digest(await readFile(bundle))));
assert.deepEqual(after, before, "Generated plugin bundles are not deterministic");
if (!process.argv.includes("--build-only")) {
  await assertBundleStarts();
}
