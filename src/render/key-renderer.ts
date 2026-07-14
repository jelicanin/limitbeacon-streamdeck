export type Severity = "healthy" | "warning" | "critical";

export type UsageKeyViewModel = {
  type: "usage";
  basis: "remaining" | "used";
  stale: boolean;
  fiveHour: UsageRow;
  weekly: UsageRow | null;
};

export type MessageKeyViewModel = {
  type: "message";
  tone: "setup" | "loading" | "error";
  title: string;
  hint: string;
};

export type KeyViewModel = UsageKeyViewModel | MessageKeyViewModel;

type UsageRow = {
  label: string;
  percent: number;
  reset: string | null;
  severity: Severity;
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

export function renderKey(model: KeyViewModel): string {
  return model.type === "usage" ? renderUsage(model) : renderMessage(model);
}

function renderUsage(model: UsageKeyViewModel): string {
  const basis = model.basis === "remaining" ? "LEFT" : "USED";
  const rows = model.weekly
    ? `${renderRow(model.fiveHour, basis, -2, 58)}${renderRow(model.weekly, basis, 78, 144)}`
    : renderSingleRow(model.fiveHour, basis);

  return svg(`
    ${model.stale ? '<text x="132" y="15" class="stale">STALE</text>' : ""}
    ${rows}
  `);
}

function renderRow(row: UsageRow, basis: string, y: number, resetY: number): string {
  const color = colors[row.severity];
  return `
    <text x="12" y="${y + 14}" class="label">${row.label} <tspan class="signal" fill="${color}">●</tspan> ${basis}</text>
    <text x="132" y="${y + 39}" class="value" fill="${color}">${formatPercent(row.percent)}</text>
    <rect x="12" y="${y + 44}" width="120" height="5" rx="2.5" class="meter-track"/>
    <rect x="12" y="${y + 44}" width="${meterWidth(row.percent)}" height="5" rx="2.5" class="meter-fill" fill="${color}"/>
    <text x="12" y="${resetY}" class="reset" dominant-baseline="text-after-edge">${escapeXml(row.reset ?? "Reset unavailable")}</text>
  `;
}

function renderSingleRow(row: UsageRow, basis: string): string {
  const color = colors[row.severity];
  return `
    <text x="72" y="24" class="single-label">${row.label} <tspan class="signal" fill="${color}">●</tspan> ${basis}</text>
    <text x="72" y="82" class="single-value" fill="${color}">${formatPercent(row.percent)}</text>
    <rect x="12" y="93" width="120" height="6" rx="3" class="meter-track"/>
    <rect x="12" y="93" width="${meterWidth(row.percent)}" height="6" rx="3" class="meter-fill" fill="${color}"/>
    <text x="72" y="136" class="single-reset" dominant-baseline="text-after-edge">${escapeXml(row.reset ?? "Reset unavailable")}</text>
  `;
}

function renderMessage(model: MessageKeyViewModel): string {
  if (model.tone === "loading") {
    return svg(`
      <circle cx="72" cy="50" r="27" class="loader-track"/>
      <circle cx="72" cy="50" r="27" class="loader"/>
      <text x="72" y="105" class="loader-name">LimitBeacon</text>
    `);
  }

  const color = model.tone === "error" ? colors.critical : colors.healthy;
  const symbol = model.tone === "error" ? "!" : "●";
  return svg(`
    <circle cx="72" cy="43" r="17" fill="#102A41" stroke="${color}" stroke-width="3"/>
    <text x="72" y="50" class="message-symbol" fill="${color}">${symbol}</text>
    <text x="72" y="82" class="message-title">${escapeXml(model.title)}</text>
    <text x="72" y="105" class="message-hint">${escapeXml(model.hint)}</text>
  `);
}

function svg(content: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
  <rect width="144" height="144" rx="18" fill="#071827"/>
  <style>
    text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    .stale { fill: #F2B84B; font-size: 9px; font-weight: 700; letter-spacing: 1.2px; text-anchor: end; }
    .label { fill: #A9C0CF; font-size: 16px; font-weight: 700; }
    .value { font-size: 28px; font-weight: 800; text-anchor: end; }
    .signal { font-size: 13px; font-weight: 800; baseline-shift: 1px; }
    .reset { fill: #A9BBC7; font-size: 18px; font-weight: 600; }
    .meter-track { fill: #233743; }
    .single-label { fill: #A9C0CF; font-size: 18px; font-weight: 700; text-anchor: middle; }
    .single-value { font-size: 42px; font-weight: 800; text-anchor: middle; }
    .single-reset { fill: #A9BBC7; font-size: 18px; font-weight: 600; text-anchor: middle; }
    .message-symbol { font-size: 20px; font-weight: 800; text-anchor: middle; }
    .message-title { fill: #E9F3F8; font-size: 13px; font-weight: 700; text-anchor: middle; }
    .message-hint { fill: #8EA9BA; font-size: 10px; text-anchor: middle; }
    .loader-track, .loader { fill: none; stroke-width: 8; }
    .loader-track { stroke: #233743; }
    .loader { stroke: #55C7E8; stroke-linecap: round; stroke-dasharray: 102 68; transform: rotate(-90deg); transform-origin: 72px 50px; }
    .loader-name { fill: #E9F3F8; font-size: 17px; font-weight: 800; text-anchor: middle; }
  </style>${content}</svg>`;
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

function meterWidth(percent: number): string {
  return String(Math.round(percent * 12) / 10);
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => xmlEntities[character] ?? character);
}
