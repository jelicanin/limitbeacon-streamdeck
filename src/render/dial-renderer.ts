import type { Severity } from "./key-renderer.js";

export type DialUsageRow = {
  label: string;
  percent: number;
  reset: string | null;
  severity: Severity;
};

export type DialViewModel =
  | {
      type: "usage";
      basis: "remaining" | "used";
      displayStyle: "bars" | "rings";
      activeIndex: number;
      stale: boolean;
      windows: DialUsageRow[];
    }
  | {
      type: "message";
      tone: "loading" | "setup" | "error";
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

export function renderDial(model: DialViewModel): string {
  return model.type === "usage" ? renderUsage(model) : renderMessage(model);
}

export function renderDialTransition(
  from: Extract<DialViewModel, { type: "usage" }>,
  to: Extract<DialViewModel, { type: "usage" }>,
  direction: -1 | 1,
  progress: number,
): string {
  const fromCard = renderUsageCard(from, false);
  const toCard = renderUsageCard(to, false);
  if (fromCard === null || toCard === null) return renderDial(to);

  const position = Math.min(1, Math.max(0, progress));
  const toX = direction * (1 - position) * 200;
  const edgeX = direction === 1 ? 0 : 198;
  return svg(`
    <g class="stationary-page">${fromCard}</g>
    <g class="incoming-page" transform="translate(${formatOffset(toX)} 0)">
      <rect width="200" height="100" fill="#071827"/>
      ${toCard}
      <rect class="page-edge" x="${edgeX}" y="0" width="2" height="100" fill="#16394A"/>
    </g>
  `);
}

function renderUsage(model: Extract<DialViewModel, { type: "usage" }>): string {
  const content = renderUsageCard(model, true);
  return content === null
    ? renderMessage({ type: "message", tone: "error", title: "No limits" })
    : svg(content);
}

function renderUsageCard(
  model: Extract<DialViewModel, { type: "usage" }>,
  showNavigation: boolean,
): string | null {
  const index = normalizeIndex(model.activeIndex, model.windows.length);
  const active = model.windows[index];
  if (active === undefined) return null;

  const previous = model.windows[normalizeIndex(index - 1, model.windows.length)];
  const next = model.windows[normalizeIndex(index + 1, model.windows.length)];
  const color = colors[active.severity];
  const basis = model.basis === "remaining" ? "LEFT" : "USED";
  const neighborMarkup = showNavigation && model.windows.length > 1
    ? `${renderNeighbor(previous, "previous", 0)}${renderNeighbor(next, "next", 182)}`
    : "";
  const visualization = model.displayStyle === "bars"
    ? renderMeter(active, color, basis)
    : renderRing(active, color, basis);
  const dotCount = model.windows.length === 1 ? 2 : model.windows.length;
  const dotIndex = model.windows.length === 1
    ? model.basis === "remaining" ? 0 : 1
    : index;

  return `
    ${neighborMarkup}
    <rect x="18" y="3" width="164" height="94" rx="12" class="card" stroke="${active.severity === "healthy" ? "none" : color}"/>
    ${visualization}
    ${model.stale ? '<text x="173" y="16" class="stale">STALE</text>' : ""}
    ${showNavigation ? renderDots(dotIndex, dotCount, color) : ""}
  `;
}

function renderRing(active: DialUsageRow, color: string, basis: string): string {
  return `
    <circle cx="55" cy="49" r="27" class="dial-ring-track"/>
    <circle cx="55" cy="49" r="27" class="dial-ring-fill" stroke="${color}" stroke-dasharray="${ringDash(active.percent, 27)} 999" transform="rotate(-90 55 49)"/>
    <text x="94" y="24" class="limit-label">${escapeXml(active.label)} · ${basis}</text>
    <text x="94" y="57" class="limit-value" fill="${color}">${formatPercent(active.percent)}</text>
    <text x="94" y="83" class="reset">RESET ${escapeXml(active.reset ?? "unavailable")}</text>
  `;
}

function renderMeter(active: DialUsageRow, color: string, basis: string): string {
  return `
    <text x="100" y="22" class="meter-label">${escapeXml(active.label)} · ${basis}</text>
    <text x="100" y="54" class="meter-value" fill="${color}">${formatPercent(active.percent)}</text>
    <rect x="48" y="61" width="104" height="7" rx="3.5" class="dial-meter-track"/>
    <rect x="48" y="61" width="${meterWidth(active.percent, 104)}" height="7" rx="3.5" class="dial-meter-fill" fill="${color}"/>
    <text x="100" y="85" class="meter-reset">RESET ${escapeXml(active.reset ?? "unavailable")}</text>
  `;
}

function renderNeighbor(
  row: DialUsageRow | undefined,
  position: "previous" | "next",
  x: number,
): string {
  if (row === undefined) return "";
  const textX = position === "previous" ? 4 : 196;
  return `
    <g class="neighbor ${position}">
      <rect x="${x}" y="12" width="18" height="76" rx="8" class="neighbor-card"/>
      <text x="${textX}" y="54" class="neighbor-label">${escapeXml(row.label)}</text>
    </g>
  `;
}

function renderDots(activeIndex: number, count: number, color: string): string {
  if (count < 2) return "";
  const gap = 8;
  const firstX = 100 - ((count - 1) * gap) / 2;
  return Array.from({ length: count }, (_, index) =>
    `<circle class="page-dot${index === activeIndex ? " active" : ""}" cx="${firstX + index * gap}" cy="91" r="2" fill="${index === activeIndex ? color : "#405766"}"/>`
  ).join("");
}

function renderMessage(model: Extract<DialViewModel, { type: "message" }>): string {
  const color = model.tone === "error" ? colors.critical : colors.healthy;
  return svg(`
    <circle cx="42" cy="50" r="20" class="message-ring" stroke="${color}"/>
    <text x="76" y="44" class="brand">LimitBeacon</text>
    <text x="76" y="65" class="message">${escapeXml(model.title)}</text>
  `);
}

function svg(content: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">
  <rect width="200" height="100" fill="#071827"/>
  <style>
    text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .card { fill: #0A2031; stroke-width: 1.5; }
    .neighbor-card { fill: #102A3D; }
    .neighbor-label { fill: #7892A2; font-size: 10px; font-weight: 700; text-anchor: middle; }
    .dial-ring-track, .dial-ring-fill { fill: none; stroke-width: 7; }
    .dial-ring-track { stroke: #243A47; }
    .dial-ring-fill { stroke-linecap: round; }
    .dial-meter-track { fill: #243A47; }
    .limit-label { fill: #ADC5D8; font-size: 12px; font-weight: 700; }
    .limit-value { font-size: 30px; font-weight: 800; }
    .reset { fill: #8FA9B9; font-size: 12px; font-weight: 600; }
    .meter-label, .meter-reset { fill: #ADC5D8; text-anchor: middle; }
    .meter-label { font-size: 12px; font-weight: 700; }
    .meter-value { font-size: 30px; font-weight: 800; text-anchor: middle; }
    .meter-reset { font-size: 12px; font-weight: 600; }
    .stale { fill: #F2B84B; font-size: 8px; font-weight: 700; text-anchor: end; }
    .message-ring { fill: none; stroke-width: 6; stroke-dasharray: 76 50; transform: rotate(-90deg); transform-origin: 42px 50px; }
    .brand { fill: #E9F3F8; font-size: 15px; font-weight: 800; }
    .message { fill: #8FA9B9; font-size: 11px; }
  </style>${content}</svg>`;
}

function normalizeIndex(index: number, count: number): number {
  if (count === 0) return 0;
  return ((index % count) + count) % count;
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

function ringDash(percent: number, radius: number): string {
  return String(Math.round((2 * Math.PI * radius * percent) / 100 * 10) / 10);
}

function meterWidth(percent: number, width: number): number {
  return Math.round(width * percent) / 100;
}

function formatOffset(value: number): string {
  return String(Math.round(value * 100) / 100);
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => xmlEntities[character] ?? character);
}
