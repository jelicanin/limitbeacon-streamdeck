import assert from "node:assert/strict";
import test from "node:test";

import { renderKey, type UsageKeyViewModel } from "../../src/render/key-renderer.js";

function usage(overrides: Partial<UsageKeyViewModel> = {}): UsageKeyViewModel {
  return {
    type: "usage",
    basis: "remaining",
    displayStyle: "bars",
    stale: false,
    fiveHour: { label: "5H", percent: 76, reset: "2h 14m", severity: "healthy" },
    weekly: { label: "7D", percent: 39, reset: "4d 8h", severity: "warning" },
    ...overrides,
  };
}

test("renders distinct five-hour and weekly values", () => {
  const svg = renderKey(usage());

  assert.match(svg, />5H <tspan[^>]*>●<\/tspan> LEFT<\/text>/u);
  assert.match(svg, /x="12" y="12" class="label">5H /u);
  assert.match(svg, /x="12" y="58" class="reset" dominant-baseline="text-after-edge">2h 14m<\/text>/u);
  assert.match(svg, />76%</u);
  assert.match(svg, />7D <tspan[^>]*>●<\/tspan> LEFT<\/text>/u);
  assert.match(svg, /x="12" y="92" class="label">7D /u);
  assert.match(svg, /x="12" y="144" class="reset" dominant-baseline="text-after-edge">4d 8h<\/text>/u);
  assert.match(svg, />39%</u);
});

test("shows USED beside each window label", () => {
  const svg = renderKey(usage({ basis: "used" }));

  assert.equal(svg.match(/ USED<\/text>/gu)?.length, 2);
  assert.doesNotMatch(svg, /class="meta"/u);
});

test("renders two stacked progress meters without decorative arcs", () => {
  const svg = renderKey(usage());

  assert.equal(svg.match(/class="meter-track"/gu)?.length, 2);
  assert.equal(svg.match(/class="meter-fill"/gu)?.length, 2);
  assert.doesNotMatch(svg, /<path\b/iu);
});

test("renders two circular gauges when ring style is selected", () => {
  const svg = renderKey(usage({ displayStyle: "rings" }));

  assert.equal(svg.match(/class="ring-track"/gu)?.length, 2);
  assert.equal(svg.match(/class="ring-fill"/gu)?.length, 2);
  assert.match(svg, />5H · LEFT</u);
  assert.match(svg, />7D · LEFT</u);
  assert.match(svg, />76%</u);
  assert.match(svg, />39%</u);
  assert.doesNotMatch(svg, /class="meter-fill"/u);
});

test("renders one large circular gauge when no secondary limit exists", () => {
  const svg = renderKey(usage({ displayStyle: "rings", weekly: null }));

  assert.equal(svg.match(/class="ring-track"/gu)?.length, 1);
  assert.equal(svg.match(/class="ring-fill"/gu)?.length, 1);
  assert.match(svg, />76%</u);
  assert.doesNotMatch(svg, />7D</u);
});

test("uses legible typography after the key is reduced to 72 pixels", () => {
  const svg = renderKey(usage());

  assert.match(svg, /\.label \{[^}]*font-size: 16px;/u);
  assert.match(svg, /\.reset \{[^}]*font-size: 18px;/u);
  assert.match(svg, /x="12"[^>]*class="label"/u);
});

test("uses the duration label supplied by Codex", () => {
  const svg = renderKey(usage({
    fiveHour: { label: "1D", percent: 76, reset: "6h", severity: "healthy" },
    weekly: null,
  }));

  assert.match(svg, />76%</u);
  assert.match(svg, />1D <tspan[^>]*>●<\/tspan> LEFT<\/text>/u);
  assert.match(svg, /x="72" y="24" class="single-label"/u);
  assert.match(svg, /x="72" y="136" class="single-reset" dominant-baseline="text-after-edge"/u);
  assert.doesNotMatch(svg, />7D /u);
});

test("warning and critical states differ by color", () => {
  const warning = renderKey(
    usage({ fiveHour: { label: "5H", percent: 30, reset: null, severity: "warning" }, weekly: null }),
  );
  const critical = renderKey(
    usage({ fiveHour: { label: "5H", percent: 10, reset: null, severity: "critical" }, weekly: null }),
  );

  assert.match(warning, /#F2B84B/u);
  assert.match(critical, /#FF6B6B/u);
});

test("stale state keeps values visible", () => {
  const svg = renderKey(usage({ stale: true }));

  assert.match(svg, />STALE</u);
  assert.match(svg, />76%</u);
  assert.match(svg, />39%</u);
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
