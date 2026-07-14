import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const pluginOutput = fileURLToPath(
  new URL("../com.jelicanin.limitbeacon.sdPlugin/bin/plugin.js", import.meta.url),
);
const inspectorOutput = fileURLToPath(
  new URL("../com.jelicanin.limitbeacon.sdPlugin/ui/index.js", import.meta.url),
);

await Promise.all([mkdir(dirname(pluginOutput), { recursive: true }), mkdir(dirname(inspectorOutput), { recursive: true })]);
await Promise.all([
  build({
    entryPoints: [fileURLToPath(new URL("../src/plugin.ts", import.meta.url))],
    outfile: pluginOutput,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    minify: false,
    sourcemap: false,
    legalComments: "none",
    banner: {
      js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
    },
    logLevel: "info",
  }),
  build({
    entryPoints: [fileURLToPath(new URL("../src/ui/inspector.ts", import.meta.url))],
    outfile: inspectorOutput,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: false,
    sourcemap: false,
    legalComments: "none",
    logLevel: "info",
  }),
]);
