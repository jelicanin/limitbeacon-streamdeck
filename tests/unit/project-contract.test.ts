import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

async function readJson(relativePath: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(new URL(relativePath, root), "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readText(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, root), "utf8");
}

test("package and manifest identify LimitBeacon consistently", async () => {
  const pkg = await readJson("package.json");
  const manifest = await readJson("com.jelicanin.limitbeacon.sdPlugin/manifest.json");

  assert.ok(pkg, "package.json must exist");
  assert.ok(manifest, "manifest.json must exist");
  assert.equal(pkg.name, "limitbeacon-streamdeck");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.author, "Milan Jelicanin");
  assert.equal(manifest.Author, "Milan Jelicanin");
  assert.equal(manifest.Category, "LimitBeacon");
  assert.equal(manifest.CategoryIcon, "imgs/category");
  assert.equal(manifest.SDKVersion, 3);
  assert.deepEqual(manifest.Nodejs, { Version: "24" });
  assert.deepEqual(manifest.OS, [
    { Platform: "mac", MinimumVersion: "13" },
    { Platform: "windows", MinimumVersion: "10" },
  ]);

  const packageVersion = String(pkg.version);
  assert.equal(manifest.Version, `${packageVersion}.0`);
  assert.equal(manifest.UUID, "com.jelicanin.limitbeacon");

  const actions = manifest.Actions as Array<Record<string, unknown>>;
  assert.equal(actions.length, 5);
  assert.match(String(actions[0]?.UUID), /^com\.jelicanin\.limitbeacon\./);
  assert.equal(actions[0]?.Icon, "imgs/actions/codex-limits-icon");
  assert.equal(actions[1]?.Name, "Limit Browser");
  assert.deepEqual(actions[1]?.Controllers, ["Encoder"]);
  assert.equal(
    (actions[1]?.Encoder as Record<string, unknown>)?.layout,
    "layouts/limit-browser.json",
  );
  assert.deepEqual(
    actions.slice(2).map((candidate) => candidate.Name),
    ["Daily Tokens", "Credits & Spend", "Activity Stats"],
  );
  for (const specialized of actions.slice(2)) {
    assert.deepEqual(specialized.Controllers, ["Encoder"]);
    assert.equal(
      (specialized.Encoder as Record<string, unknown>)?.layout,
      "layouts/limit-browser.json",
    );
  }
});

test("unit tests run serially because the Stream Deck SDK rotates a shared log", async () => {
  const pkg = JSON.parse(await readText("package.json")) as {
    scripts: Record<string, string>;
  };

  assert.match(pkg.scripts.test ?? "", /--test-concurrency=1/u);
});

test("property inspector includes concise self-contained setup help", async () => {
  const html = await readText("com.jelicanin.limitbeacon.sdPlugin/ui/index.html");

  assert.match(html, /id="help-tab"/u);
  assert.match(html, /aria-controls="help-panel"/u);
  assert.match(html, /Install Codex/u);
  assert.match(html, /Sign in to Codex/u);
  assert.match(html, /Return to Stream Deck/u);
  assert.match(html, /https:\/\/developers\.openai\.com\/codex\/cli\//u);
  assert.match(html, /https:\/\/developers\.openai\.com\/codex\/auth\//u);
  assert.doesNotMatch(html, /com\.jelicanin|limitbeacon-streamdeck/iu);
});

test("default key image uses stacked meters instead of radar arcs", async () => {
  const svg = await readText("com.jelicanin.limitbeacon.sdPlugin/imgs/actions/codex-limits.svg");

  assert.equal(svg.match(/class="meter-track"/gu)?.length, 2);
  assert.doesNotMatch(svg, /<path\b/iu);
});

test("property inspector stores key visuals per action and connection settings globally", async () => {
  const source = await readText("src/ui/inspector.ts");

  assert.match(source, /event: "setSettings"/u);
  assert.match(source, /event: "setGlobalSettings"/u);
  assert.match(source, /message\.event === "didReceiveSettings"/u);
  assert.match(source, /event: "setSettings",[\s\S]*?context: propertyInspectorId/u);
  assert.doesNotMatch(source, /actionContext/u);
});

test("property inspector offers stacked bars and ring gauges per key", async () => {
  const html = await readText("com.jelicanin.limitbeacon.sdPlugin/ui/index.html");
  const source = await readText("src/ui/inspector.ts");

  assert.match(html, /name="displayStyle"/u);
  assert.match(html, /name="displayStyle" value="bars"/u);
  assert.match(html, /name="displayStyle" value="rings"/u);
  assert.match(source, /"displayStyle"/u);
});

test("short display choices are visible as horizontal radio groups", async () => {
  const html = await readText("com.jelicanin.limitbeacon.sdPlugin/ui/index.html");
  const css = await readText("com.jelicanin.limitbeacon.sdPlugin/ui/index.css");

  for (const name of ["displayStyle", "basis", "resetStyle"]) {
    assert.doesNotMatch(html, new RegExp(`<select name="${name}"`, "u"));
    assert.match(html, new RegExp(`type="radio" name="${name}"`, "u"));
  }
  assert.match(html, /<select name="refreshMinutes">/u);
  assert.match(css, /\.radio-group/u);
  assert.match(css, /grid-auto-flow:\s*column/u);
});

test("limit browser exposes the shared inspector with dial-specific display controls", async () => {
  const manifest = JSON.parse(
    await readText("com.jelicanin.limitbeacon.sdPlugin/manifest.json"),
  ) as { Actions: Array<Record<string, unknown>> };
  const action = manifest.Actions.find((candidate) => candidate.Name === "Limit Browser");
  const html = await readText("com.jelicanin.limitbeacon.sdPlugin/ui/index.html");
  const source = await readText("src/ui/inspector.ts");

  assert.equal(action?.PropertyInspectorPath, "ui/index.html");
  assert.match(html, /name="displayStyle" value="bars"/u);
  assert.match(html, /name="displayStyle" value="rings"/u);
  assert.match(html, /data-key-only/u);
  assert.match(source, /isDialInspector/u);
});

test("specialized dials expose focused help without irrelevant display settings", async () => {
  const html = await readText("com.jelicanin.limitbeacon.sdPlugin/ui/index.html");
  const source = await readText("src/ui/inspector.ts");

  assert.match(html, /id="specialized-guide"/u);
  assert.match(html, /id="specialized-guide-title"/u);
  assert.match(source, /SPECIALIZED_DIALS/u);
  assert.match(source, /Daily Tokens/u);
  assert.match(source, /Credits & Spend/u);
  assert.match(source, /Activity Stats/u);
});
