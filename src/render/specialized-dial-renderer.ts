import type { Severity } from "./key-renderer.js";

export type SpecializedCard =
  | {
      kind: "daily";
      label: string;
      value: string;
      detail: string;
      bars: number[];
      activeBar: number;
    }
  | {
      kind: "meter";
      label: string;
      value: string;
      detail: string;
      percent: number;
      tone: Severity;
    }
  | {
      kind: "stat";
      label: string;
      value: string;
      detail: string;
      tone: Severity;
    };

export type SpecializedDialViewModel =
  | {
      type: "cards";
      activeIndex: number;
      stale: boolean;
      cards: SpecializedCard[];
    }
  | {
      type: "message";
      tone: "loading" | "setup" | "empty" | "error";
      title: string;
    };

const colors: Record<Severity, string> = {
  healthy: "#55C7E8",
  warning: "#F2B84B",
  critical: "#FF6B6B",
};

const xmlEntities: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

export function renderSpecializedDial(model: SpecializedDialViewModel): string {
  return model.type === "cards" ? renderCards(model) : renderMessage(model);
}

export function renderSpecializedDialTransition(
  from: Extract<SpecializedDialViewModel, { type: "cards" }>,
  to: Extract<SpecializedDialViewModel, { type: "cards" }>,
  direction: -1 | 1,
  progress: number,
): string {
  const fromCard = activeCard(from);
  const toCard = activeCard(to);
  if (fromCard === null || toCard === null) return renderSpecializedDial(to);

  const position = Math.min(1, Math.max(0, progress));
  const offset = direction * (1 - position) * 200;
  const edgeX = direction === 1 ? 0 : 198;
  return svg(`
    <g class="stationary-page">${renderCard(fromCard)}</g>
    <g class="incoming-page" transform="translate(${formatNumber(offset)} 0)">
      <rect width="200" height="100" fill="#071827"/>
      ${renderCard(toCard)}
      <rect class="page-edge" x="${edgeX}" y="0" width="2" height="100" fill="#16394A"/>
    </g>
  `);
}

function renderCards(model: Extract<SpecializedDialViewModel, { type: "cards" }>): string {
  const card = activeCard(model);
  if (card === null) {
    return renderMessage({ type: "message", tone: "empty", title: "Not available" });
  }
  return svg(`
    ${renderCard(card)}
    ${model.stale ? '<text x="173" y="16" class="stale">STALE</text>' : ""}
    ${renderDots(model.activeIndex, model.cards.length, cardColor(card))}
  `);
}

function renderCard(card: SpecializedCard): string {
  const color = cardColor(card);
  const content = card.kind === "daily"
    ? renderDaily(card, color)
    : card.kind === "meter"
    ? renderMeter(card, color)
    : renderStat(card, color);
  const border = card.kind === "daily" || card.tone === "healthy" ? "none" : color;
  return `<rect x="18" y="3" width="164" height="94" rx="12" class="card" stroke="${border}"/>${content}`;
}

function renderDaily(card: Extract<SpecializedCard, { kind: "daily" }>, color: string): string {
  const bars = card.bars.slice(0, 7);
  const chart = bars.map((value, index) => {
    const height = 5 + Math.round(clampPercent(value) * 0.17);
    const x = 113 + index * 9;
    const active = index === card.activeBar;
    return `<rect class="daily-bar${active ? " active" : ""}" x="${x}" y="${82 - height}" width="6" height="${height}" rx="3" fill="${active ? color : "#405766"}"/>`;
  }).join("");
  return `
    <text x="31" y="25" class="card-label">${escapeXml(card.label)}</text>
    <text x="31" y="58" class="daily-value${card.value.length > 5 ? " compact" : ""}" fill="${color}">${escapeXml(card.value)}</text>
    <text x="31" y="82" class="card-detail">${escapeXml(card.detail)}</text>
    <g class="daily-chart">${chart}</g>
  `;
}

function renderMeter(card: Extract<SpecializedCard, { kind: "meter" }>, color: string): string {
  return `
    <text x="100" y="24" class="center-label">${escapeXml(card.label)}</text>
    <text x="100" y="55" class="center-value" fill="${color}">${escapeXml(card.value)}</text>
    <rect x="48" y="62" width="104" height="7" rx="3.5" class="special-meter-track"/>
    <rect x="48" y="62" width="${meterWidth(card.percent, 104)}" height="7" rx="3.5" class="special-meter-fill" fill="${color}"/>
    <text x="100" y="84" class="center-detail">${escapeXml(card.detail)}</text>
  `;
}

function renderStat(card: Extract<SpecializedCard, { kind: "stat" }>, color: string): string {
  return `
    <text x="100" y="26" class="center-label">${escapeXml(card.label)}</text>
    <text x="100" y="62" class="stat-value" fill="${color}">${escapeXml(card.value)}</text>
    <text x="100" y="84" class="center-detail">${escapeXml(card.detail)}</text>
  `;
}

function renderMessage(model: Extract<SpecializedDialViewModel, { type: "message" }>): string {
  const color = model.tone === "error" ? colors.critical : colors.healthy;
  return svg(`
    <rect x="18" y="3" width="164" height="94" rx="12" class="card" stroke="none"/>
    <text x="100" y="45" class="message-brand">LimitBeacon</text>
    <text x="100" y="66" class="message-title">${escapeXml(model.title)}</text>
  `);
}

function svg(content: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">
  <rect width="200" height="100" fill="#071827"/>
  <style>
    text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .card { fill: #0A2031; stroke-width: 1.5; }
    .card-label, .center-label { fill: #ADC5D8; font-size: 12px; font-weight: 700; }
    .daily-value { font-size: 30px; font-weight: 800; }
    .daily-value.compact { font-size: 22px; }
    .card-detail { fill: #8FA9B9; font-size: 12px; font-weight: 600; }
    .center-label, .center-value, .stat-value, .center-detail { text-anchor: middle; }
    .center-value { font-size: 29px; font-weight: 800; }
    .stat-value { font-size: 31px; font-weight: 800; }
    .center-detail { fill: #8FA9B9; font-size: 12px; font-weight: 600; }
    .special-meter-track { fill: #243A47; }
    .stale { fill: #F2B84B; font-size: 8px; font-weight: 700; text-anchor: end; }
    .message-brand { fill: #E9F3F8; font-size: 15px; font-weight: 800; text-anchor: middle; }
    .message-title { fill: #8FA9B9; font-size: 12px; font-weight: 600; text-anchor: middle; }
  </style>${content}</svg>`;
}

function activeCard(model: Extract<SpecializedDialViewModel, { type: "cards" }>): SpecializedCard | null {
  if (model.cards.length === 0) return null;
  return model.cards[normalizeIndex(model.activeIndex, model.cards.length)] ?? null;
}

function cardColor(card: SpecializedCard): string {
  return card.kind === "daily" ? colors.healthy : colors[card.tone];
}

function renderDots(activeIndex: number, count: number, color: string): string {
  if (count < 2 || count > 8) return "";
  const gap = 8;
  const normalized = normalizeIndex(activeIndex, count);
  const firstX = 100 - ((count - 1) * gap) / 2;
  return Array.from({ length: count }, (_, index) =>
    `<circle cx="${firstX + index * gap}" cy="91" r="2" fill="${index === normalized ? color : "#405766"}"/>`
  ).join("");
}

function normalizeIndex(index: number, count: number): number {
  if (count === 0) return 0;
  return ((index % count) + count) % count;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));
}

function meterWidth(percent: number, width: number): number {
  return Math.round(width * clampPercent(percent)) / 100;
}

function formatNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => xmlEntities[character] ?? character);
}
