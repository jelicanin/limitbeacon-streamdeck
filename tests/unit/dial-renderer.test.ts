import assert from "node:assert/strict";
import test from "node:test";

import {
  renderDial,
  renderDialTransition,
  type DialViewModel,
} from "../../src/render/dial-renderer.js";

type UsageModel = Extract<DialViewModel, { type: "usage" }>;

function usage(overrides: Partial<UsageModel> = {}): UsageModel {
  return {
    type: "usage",
    basis: "remaining",
    displayStyle: "rings",
    activeIndex: 0,
    stale: false,
    windows: [
      { label: "5H", percent: 76, reset: "2h 14m", severity: "healthy" },
      { label: "7D", percent: 39, reset: "4d 8h", severity: "warning" },
    ],
    ...overrides,
  };
}

test("renders one landscape carousel card with clipped neighboring limits", () => {
  const svg = renderDial(usage({ activeIndex: 1 }));

  assert.match(svg, /width="200" height="100"/u);
  assert.match(svg, /class="neighbor previous"/u);
  assert.match(svg, /class="neighbor next"/u);
  assert.match(svg, />7D · LEFT</u);
  assert.match(svg, />39%</u);
  assert.doesNotMatch(svg, /class="basis"/u);
  assert.match(svg, />RESET 4d 8h</u);
  assert.match(svg, /class="dial-ring-fill"/u);
  assert.doesNotMatch(svg, /class="meter-fill"/u);
});

test("shows the card border only for warning and critical limits", () => {
  const healthy = renderDial(usage({
    windows: [{ label: "7D", percent: 76, reset: "6d 20h", severity: "healthy" }],
  }));
  const warning = renderDial(usage({
    windows: [{ label: "7D", percent: 35, reset: "6d 20h", severity: "warning" }],
  }));
  const critical = renderDial(usage({
    windows: [{ label: "7D", percent: 15, reset: "6d 20h", severity: "critical" }],
  }));

  assert.match(healthy, /class="card" stroke="none"/u);
  assert.match(warning, /class="card" stroke="#F2B84B"/u);
  assert.match(critical, /class="card" stroke="#FF6B6B"/u);
});

test("renders used basis and selected percentage", () => {
  const svg = renderDial(usage({
    basis: "used",
    windows: [{ label: "5H", percent: 24, reset: "2h 14m", severity: "healthy" }],
  }));

  assert.match(svg, />24%</u);
  assert.match(svg, />5H · USED</u);
  assert.doesNotMatch(svg, /class="basis"/u);
});

test("shows LEFT and USED as two pages when only one limit is available", () => {
  const windows = [{ label: "7D", percent: 76, reset: "6d 20h", severity: "healthy" as const }];
  const remaining = renderDial(usage({ basis: "remaining", windows }));
  const used = renderDial(usage({ basis: "used", windows }));

  assert.equal(remaining.match(/class="page-dot/gu)?.length, 2);
  assert.match(remaining, /class="page-dot active" cx="96"/u);
  assert.match(used, /class="page-dot active" cx="104"/u);
});

test("renders a horizontal progress bar when bar style is selected", () => {
  const svg = renderDial(usage({ displayStyle: "bars", activeIndex: 1 }));

  assert.match(svg, /class="dial-meter-track"/u);
  assert.match(svg, /class="dial-meter-fill"/u);
  assert.match(svg, />7D · LEFT</u);
  assert.match(svg, />39%</u);
  assert.doesNotMatch(svg, /class="dial-ring-fill"/u);
});

test("uses top-line typography and balanced margins for reset text", () => {
  const ring = renderDial(usage());
  const bar = renderDial(usage({ displayStyle: "bars" }));

  assert.match(ring, /<text x="94" y="83" class="reset">/u);
  assert.match(bar, /<text x="100" y="85" class="meter-reset">/u);
  assert.match(ring, /\.reset \{[^}]*font-size: 12px/u);
  assert.match(bar, /\.meter-reset \{ font-size: 12px/u);
});

test("renders a concise loading state", () => {
  const svg = renderDial({ type: "message", tone: "loading", title: "Starting" });

  assert.match(svg, />LimitBeacon</u);
  assert.match(svg, />Starting</u);
});

test("renders the incoming page over a stationary page during a dial transition", () => {
  const from = usage({
    basis: "remaining",
    windows: [{ label: "7D", percent: 54, reset: "5d 23h", severity: "healthy" }],
  });
  const to = usage({
    basis: "used",
    windows: [{ label: "7D", percent: 46, reset: "5d 23h", severity: "healthy" }],
  });

  const svg = renderDialTransition(from, to, 1, 0.5);

  assert.match(svg, /class="stationary-page"/u);
  assert.match(svg, /class="incoming-page" transform="translate\(100 0\)"/u);
  assert.match(svg, /class="page-edge" x="0"/u);
  assert.match(svg, /transform="translate\(100 0\)"/u);
  assert.match(svg, />7D · LEFT</u);
  assert.match(svg, />7D · USED</u);
  assert.match(svg, />54%</u);
  assert.match(svg, />46%</u);
});

test("moves the incoming page from the left for counter-clockwise rotation", () => {
  const from = usage({ basis: "remaining" });
  const to = usage({ basis: "used" });

  const svg = renderDialTransition(from, to, -1, 0.5);

  assert.match(svg, /class="incoming-page" transform="translate\(-100 0\)"/u);
  assert.match(svg, /class="page-edge" x="198"/u);
});
