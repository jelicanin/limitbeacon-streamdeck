import assert from "node:assert/strict";
import test from "node:test";

import { renderKey, type UsageKeyViewModel } from "../../src/render/key-renderer.js";

function usage(overrides: Partial<UsageKeyViewModel> = {}): UsageKeyViewModel {
  return {
    type: "usage",
    basis: "remaining",
    displayStyle: "bars",
    stale: false,
    window: { label: "5H", percent: 76, reset: "2h 14m", severity: "healthy" },
    ...overrides,
  };
}

for (const displayStyle of ["bars", "rings"] as const) {
  test(`${displayStyle} renders one indicator, percentage, duration and reset`, () => {
    const svg = renderKey(usage({displayStyle}));
    assert.equal(svg.match(/class="(?:meter|ring)-track"/gu)?.length, 1);
    assert.equal(svg.match(/class="(?:meter|ring)-fill"/gu)?.length, 1);
    assert.equal(svg.match(/>\d+%</gu)?.length, 1);
    assert.match(svg, />76%</u);
    assert.match(svg, />5H(?: ·| <tspan)/u);
    assert.equal(svg.match(/>2h 14m</gu)?.length, 1);
  });
}

test("shows USED beside the selected window label", () => {
  const svg = renderKey(usage({basis: "used"}));
  assert.equal(svg.match(/ USED<\/text>/gu)?.length, 1);
});

test("uses the duration label supplied by Codex", () => {
  const svg = renderKey(usage({
    window: { label: "1D", percent: 76, reset: "6h", severity: "healthy" },
  }));

  assert.match(svg, />76%</u);
  assert.match(svg, />1D <tspan[^>]*>●<\/tspan> LEFT<\/text>/u);
  assert.match(svg, /x="72" y="24" class="single-label"/u);
  assert.match(svg, /x="72" y="136" class="single-reset" dominant-baseline="text-after-edge"/u);
  assert.doesNotMatch(svg, />7D /u);
});

test("warning and critical states differ by color", () => {
  const warning = renderKey(
    usage({ window: { label: "5H", percent: 30, reset: null, severity: "warning" } }),
  );
  const critical = renderKey(
    usage({ window: { label: "5H", percent: 10, reset: null, severity: "critical" } }),
  );

  assert.match(warning, /#F2B84B/u);
  assert.match(critical, /#FF6B6B/u);
});

test("stale state keeps values visible", () => {
  const svg = renderKey(usage({ stale: true }));

  assert.match(svg, />STALE</u);
  assert.match(svg, />76%</u);
});

test("setup and error states use short actionable labels", () => {
  assert.match(
    renderKey({ type: "message", tone: "setup", title: "Install Codex", hint: "Open setup" }),
    />Install Codex</u,
  );
  assert.match(
    renderKey({ type: "message", tone: "error", title: "Could not refresh", hint: "Press to retry" }),
    />Press to retry</u,
  );
});

test("loading state uses a large branded spinner", () => {
  const svg = renderKey({
    type: "message",
    tone: "loading",
    title: "Codex is starting",
    hint: "Please wait",
  });

  assert.match(svg, /class="loader"/u);
  assert.match(svg, /r="27"/u);
  assert.match(svg, />LimitBeacon<\/text>/u);
  assert.doesNotMatch(svg, />Codex is starting<\/text>/u);
});

test("dynamic message text is XML escaped", () => {
  const svg = renderKey({
    type: "message",
    tone: "error",
    title: "A < B & C",
    hint: 'Retry "now"',
  });

  assert.match(svg, /A &lt; B &amp; C/u);
  assert.match(svg, /Retry &quot;now&quot;/u);
  assert.doesNotMatch(svg, /A < B & C/u);
});

test("rendered UI contains no internal namespace", () => {
  assert.doesNotMatch(renderKey(usage()), /com\.jelicanin|limitbeacon-streamdeck/iu);
});

test("ring reset stays unavailable when Codex supplies no reset time", () => {
  const svg = renderKey(usage({displayStyle: "rings", window: {label: "5H", percent: 76, reset: null, severity: "healthy"}}));
  assert.equal(svg.match(/>Reset —</gu)?.length, 1);
  assert.doesNotMatch(svg, />No reset</u);
});
