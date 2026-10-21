import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
const { WebSocketServer } = createRequire(import.meta.resolve("@elgato/streamdeck"))("ws");
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
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let registered = false;
  let settingsRequested = false;
  let finish;
  const handshake = new Promise(resolve => { finish = resolve; });
  server.on("connection", socket => socket.on("message", raw => {
    const message = JSON.parse(raw.toString());
    if (message.event === "registerPlugin" && message.uuid === "startup-smoke") registered = true;
    if (message.event === "getGlobalSettings" && typeof message.id === "string") {
      settingsRequested = true;
      socket.send(JSON.stringify({event:"didReceiveGlobalSettings", id:message.id,
        payload:{settings:{refreshMinutes:5}}}));
      finish("ready");
    }
  }));
  const child = spawn(process.execPath, [bundles[0], "-port", String(address.port),
    "-pluginUUID", "startup-smoke", "-registerEvent", "registerPlugin", "-info",
    JSON.stringify({application:{version:"7.6.0",platform:process.platform === "win32" ? "windows" : "mac",language:"en"},
      plugin:{uuid:"com.jelicanin.limitbeacon",version:"1.3.0"},devices:[]})],
    {cwd:fileURLToPath(new URL("../com.jelicanin.limitbeacon.sdPlugin/", import.meta.url)), stdio:["ignore","ignore","pipe"]});
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", chunk => { stderr += chunk; });
  const exit = new Promise(resolve => child.once("exit", code => resolve(`exit:${code}`)));
  let timer;
  try {
    const result = await Promise.race([handshake, exit,
      new Promise(resolve => {timer=setTimeout(()=>resolve("timeout"),5000);})]);
    assert.equal(result, "ready", `Plugin did not register and request settings: ${result} ${stderr}`);
    assert.ok(registered && settingsRequested, "SDK 3 handshake was incomplete");
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
    await exit;
    for (const client of server.clients) client.terminate();
    await new Promise(resolve => server.close(resolve));
  }
}

await rebuild();
const before = await Promise.all(bundles.map(async (bundle) => digest(await readFile(bundle))));
await rebuild();
const after = await Promise.all(bundles.map(async (bundle) => digest(await readFile(bundle))));
assert.deepEqual(after, before, "Generated plugin bundles are not deterministic");
if (!process.argv.includes("--build-only")) {
  await assertBundleStarts();
}
