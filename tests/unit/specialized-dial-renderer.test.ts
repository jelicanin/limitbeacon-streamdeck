import assert from "node:assert/strict";
import test from "node:test";

import {
  renderSpecializedDial,
  renderSpecializedDialTransition,
  type SpecializedDialViewModel,
} from "../../src/render/specialized-dial-renderer.js";

type CardsModel = Extract<SpecializedDialViewModel, { type: "cards" }>;

function cards(overrides: Partial<CardsModel> = {}): CardsModel {
  return {
    type: "cards",
    activeIndex: 0,
    stale: false,
    cards: [
      {
        kind: "daily",
        label: "TODAY",
        value: "500K",
        detail: "22/07",
        bars: [20, 40, 30, 70, 50, 90, 60],
        activeBar: 6,
      },
    ],
    ...overrides,
  };
}

test("renders a daily token card with seven bars and an active day", () => {
  const svg = renderSpecializedDial(cards());

  assert.match(svg, />TODAY</u);
  assert.match(svg, />500K</u);
  assert.match(svg, />22\/07</u);
  assert.equal(svg.match(/class="daily-bar/gu)?.length, 7);
  assert.equal(svg.match(/class="daily-bar active/gu)?.length, 1);
  assert.match(svg, /class="card" stroke="none"/u);
});

test("keeps a long daily token value clear of the seven-day chart", () => {
  const svg = renderSpecializedDial(cards({
    cards: [{
      kind: "daily",
      label: "DAILY TOKENS",
      value: "368.9M",
      detail: "19. 07.",
      bars: [20, 40, 30, 70, 50, 90, 60],
      activeBar: 6,
    }],
  }));

  assert.match(svg, /class="daily-value compact"/u);
  assert.match(svg, /class="daily-bar" x="113" y="74"/u);
});

test("renders credits and spend as a horizontal meter without a ring", () => {
  const svg = renderSpecializedDial(cards({
    cards: [{
      kind: "meter",
      label: "SPEND LEFT",
      value: "60%",
      detail: "40 / 100",
      percent: 60,
      tone: "healthy",
    }],
  }));

  assert.match(svg, />SPEND LEFT</u);
  assert.match(svg, />60%</u);
  assert.match(svg, /class="special-meter-fill"/u);
  assert.doesNotMatch(svg, /<circle/iu);
});

test("shows the specialized card border only for warning and critical thresholds", () => {
  const warning = renderSpecializedDial(cards({
    cards: [{
      kind: "meter",
      label: "SPEND LEFT",
      value: "35%",
      detail: "35 / 100",
      percent: 35,
      tone: "warning",
    }],
  }));
  const critical = renderSpecializedDial(cards({
    cards: [{
      kind: "meter",
      label: "SPEND LEFT",
      value: "15%",
      detail: "15 / 100",
      percent: 15,
      tone: "critical",
    }],
  }));

  assert.match(warning, /class="card" stroke="#F2B84B"/u);
  assert.match(critical, /class="card" stroke="#FF6B6B"/u);
});

test("renders an activity metric as a typographic card", () => {
  const svg = renderSpecializedDial(cards({
    cards: [{
      kind: "stat",
      label: "LIFETIME TOKENS",
      value: "123.5M",
      detail: "ALL TIME",
      tone: "healthy",
    }],
  }));

  assert.match(svg, />LIFETIME TOKENS</u);
  assert.match(svg, />123\.5M</u);
  assert.match(svg, />ALL TIME</u);
  assert.doesNotMatch(svg, /special-meter-fill/u);
});

test("renders a concise unavailable state", () => {
  const svg = renderSpecializedDial({
    type: "message",
    tone: "empty",
    title: "Not available",
  });

  assert.match(svg, />LimitBeacon</u);
  assert.match(svg, />Not available</u);
  assert.match(svg, /class="card" stroke="none"/u);
});

test("slides the incoming specialized card over the current card", () => {
  const from = cards();
  const to = cards({
    cards: [{
      kind: "stat",
      label: "7D TOTAL",
      value: "3.2M",
      detail: "TOKENS",
      tone: "healthy",
    }],
  });

  const svg = renderSpecializedDialTransition(from, to, 1, 0.5);

  assert.match(svg, /class="incoming-page" transform="translate\(100 0\)"/u);
  assert.match(svg, />500K</u);
  assert.match(svg, />3\.2M</u);
});
