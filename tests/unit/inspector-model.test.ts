import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectorStatusModel,
  type InspectorStatusId,
} from "../../src/ui/inspector-model.js";

const expectations: ReadonlyArray<
  readonly [InspectorStatusId, string, string]
> = [
  ["connected", "Connected", "Refresh now"],
  ["codex-missing", "Codex not found", "Install Codex"],
  ["sign-in-required", "Sign in to Codex", "Open login guide"],
  ["starting", "Codex is starting", "Please wait"],
  ["stale", "Last update is stale", "Retry"],
  ["incompatible", "Codex changed", "Update Codex"],
  ["error", "Could not refresh", "Retry"],
];

for (const [status, title, actionLabel] of expectations) {
  test(`${status} exposes one recommended action`, () => {
    const model = inspectorStatusModel(status);

    assert.equal(model.title, title);
    assert.equal(model.action.label, actionLabel);
    assert.ok(model.action.kind === "button" || model.action.kind === "link");
  });
}
