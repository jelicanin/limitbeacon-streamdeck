import { normalizeSettings, type LimitBeaconSettings } from "../domain/settings.js";
import { normalizeDialSettings, type DialSettings } from "../domain/dial-settings.js";
import {
  inspectorStatusModel,
  type InspectorStatusId,
} from "./inspector-model.js";

declare global {
  interface Window {
    connectElgatoStreamDeckSocket(
      port: string,
      propertyInspectorId: string,
      registerEvent: string,
      info: string,
      actionInfo: string,
    ): void;
  }
}

const form = requiredElement<HTMLFormElement>("settings-form");
const status = document.querySelector<HTMLElement>(".status");
const statusTitle = requiredElement("status-title");
const statusDetail = requiredElement("status-detail");
const statusAction = requiredElement("status-action");
const thresholdError = requiredElement("threshold-error");
const tabButtons = document.querySelectorAll<HTMLButtonElement>("[role=tab]");
const keySettingNames = new Set([
  "basis", "displayStyle", "resetStyle", "warningThreshold", "criticalThreshold",
]);
const globalSettingNames = new Set(["refreshMinutes", "codexExecutable"]);
const DIAL_ACTION_ID = "com.jelicanin.limitbeacon.limit-browser";
const SPECIALIZED_DIALS = new Map([
  ["com.jelicanin.limitbeacon.daily-tokens", {
    title: "Daily Tokens",
    detail: "Review daily token usage and a compact seven-day summary.",
    controls: "Rotate to browse. Touch the display to switch between days and summaries. Press the dial to refresh.",
  }],
  ["com.jelicanin.limitbeacon.credits-spend", {
    title: "Credits & Spend",
    detail: "Review available credits, spend allowance, and reset credits when Codex provides them.",
    controls: "Rotate to browse available cards. Press the dial to refresh.",
  }],
  ["com.jelicanin.limitbeacon.activity-stats", {
    title: "Activity Stats",
    detail: "Review lifetime tokens, peak usage, streaks, and longest turn when available.",
    controls: "Rotate to browse available statistics. Press the dial to refresh.",
  }],
]);
let socket: WebSocket | undefined;
let propertyInspectorId = "";
let actionId = "";
let isDialInspector = false;
let isBrowserDialInspector = false;
let specializedDial: { title: string; detail: string; controls: string } | undefined;
let dialSettings = normalizeDialSettings(undefined);

window.connectElgatoStreamDeckSocket = (port, inspectorId, registerEvent, info, actionInfo) => {
  propertyInspectorId = inspectorId;
  const action = readActionInfo(actionInfo);
  actionId = action.id;
  isBrowserDialInspector = action.id === DIAL_ACTION_ID;
  specializedDial = SPECIALIZED_DIALS.get(action.id);
  isDialInspector = isBrowserDialInspector || specializedDial !== undefined;
  configureInspector();
  if (isBrowserDialInspector) setDialForm(action.settings);
  else if (specializedDial === undefined) setKeyForm(action.settings);
  applyHostFont(info);
  socket = new WebSocket(`ws://127.0.0.1:${port}`);
  socket.addEventListener("open", () => {
    send({ event: registerEvent, uuid: inspectorId });
    send({ event: "getSettings", action: actionId, context: propertyInspectorId });
    send({ event: "getGlobalSettings", context: inspectorId });
  });
  socket.addEventListener("message", (event) => receive(event.data));
};

for (const button of tabButtons) {
  button.addEventListener("click", () => selectTab(button));
}

for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-open-url]")) {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    send({ event: "openUrl", payload: { url: link.href } });
  });
}

form.addEventListener("change", (event) => {
  const name = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement
    ? event.target.name
    : "";
  if (isBrowserDialInspector && name === "displayStyle") {
    dialSettings = { ...dialSettings, displayStyle: selectedDisplayStyle() };
    send({
      event: "setSettings",
      action: actionId,
      context: propertyInspectorId,
      payload: dialSettings,
    });
    return;
  }
  const settings = readForm();
  if (settings === null) return;
  if (!isDialInspector && keySettingNames.has(name)) {
    send({
      event: "setSettings",
      action: actionId,
      context: propertyInspectorId,
      payload: keySettings(settings),
    });
  } else if (globalSettingNames.has(name)) {
    send({
      event: "setGlobalSettings",
      context: propertyInspectorId,
      payload: globalSettings(settings),
    });
  }
});

function receive(raw: unknown): void {
  if (typeof raw !== "string") return;
  try {
    const message = JSON.parse(raw) as unknown;
    if (!isRecord(message)) return;
    const payload = isRecord(message.payload) ? message.payload : {};
    if (message.event === "didReceiveSettings") {
      if (isBrowserDialInspector) setDialForm(payload.settings);
      else if (specializedDial === undefined) setKeyForm(payload.settings);
    }
    if (message.event === "didReceiveGlobalSettings") setGlobalForm(payload.settings);
    if (message.event === "sendToPropertyInspector" && isStatus(payload.status)) {
      renderStatus(payload.status);
    }
  } catch {
    // Ignore malformed host messages and keep the inspector usable.
  }
}

function setDialForm(raw: unknown): void {
  dialSettings = normalizeDialSettings(raw);
  setField("displayStyle", dialSettings.displayStyle);
}

function selectedDisplayStyle(): DialSettings["displayStyle"] {
  return new FormData(form).get("displayStyle") === "bars" ? "bars" : "rings";
}

function configureInspector(): void {
  if (isDialInspector) {
    for (const element of document.querySelectorAll<HTMLElement>("[data-key-only]")) {
      element.hidden = true;
    }
  }
  if (specializedDial !== undefined) {
    for (const element of document.querySelectorAll<HTMLElement>("[data-configurable-display]")) {
      element.hidden = true;
    }
    const guide = requiredElement("specialized-guide");
    guide.hidden = false;
    requiredElement("specialized-guide-title").textContent = specializedDial.title;
    requiredElement("specialized-guide-detail").textContent = specializedDial.detail;
    requiredElement("specialized-guide-controls").textContent = specializedDial.controls;
    const help = requiredElement("specialized-help");
    help.hidden = false;
    requiredElement("specialized-help-title").textContent = `${specializedDial.title} controls`;
    requiredElement("specialized-help-copy").textContent = specializedDial.controls;
  }
}

function setKeyForm(raw: unknown): void {
  const settings = normalizeSettings(raw);
  setField("basis", settings.basis);
  setField("displayStyle", settings.displayStyle);
  setField("resetStyle", settings.resetStyle);
  setField("warningThreshold", settings.warningThreshold);
  setField("criticalThreshold", settings.criticalThreshold);
}

function setGlobalForm(raw: unknown): void {
  const settings = normalizeSettings(raw);
  setField("refreshMinutes", settings.refreshMinutes);
  setField("codexExecutable", settings.codexExecutable);
}

function readForm(): LimitBeaconSettings | null {
  const data = new FormData(form);
  try {
    const settings = normalizeSettings({
      basis: data.get("basis"),
      displayStyle: data.get("displayStyle"),
      resetStyle: data.get("resetStyle"),
      warningThreshold: Number(data.get("warningThreshold")),
      criticalThreshold: Number(data.get("criticalThreshold")),
      refreshMinutes: Number(data.get("refreshMinutes")),
      codexExecutable: data.get("codexExecutable"),
    });
    thresholdError.hidden = true;
    return settings;
  } catch {
    thresholdError.hidden = false;
    return null;
  }
}

function renderStatus(id: InspectorStatusId): void {
  const model = inspectorStatusModel(id);
  status?.setAttribute("data-tone", id === "connected" ? "connected" : id === "starting" ? "starting" : "error");
  statusTitle.textContent = model.title;
  statusDetail.textContent = model.detail;
  statusAction.replaceChildren();

  if (model.action.kind === "link") {
    const href = model.action.href;
    const link = document.createElement("a");
    link.className = "action-link";
    link.href = href;
    link.textContent = model.action.label;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      send({ event: "openUrl", payload: { url: href } });
    });
    statusAction.append(link);
    return;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = model.action.label;
  button.disabled = model.action.disabled ?? false;
  button.addEventListener("click", () => {
    send({
      event: "sendToPlugin",
      action: actionId,
      context: propertyInspectorId,
      payload: { command: model.action.kind === "button" ? model.action.command : "refresh" },
    });
  });
  statusAction.append(button);
}

function send(message: object): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function setField(name: string, value: string | number): void {
  const field = form.elements.namedItem(name);
  if (field instanceof RadioNodeList) {
    field.value = String(value);
    return;
  }
  if (field instanceof HTMLInputElement || field instanceof HTMLSelectElement) {
    field.value = String(value);
  }
}

function readActionInfo(raw: string): { id: string; settings: unknown } {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value)) return { id: "", settings: undefined };
    const payload = isRecord(value.payload) ? value.payload : {};
    return {
      id: typeof value.action === "string" ? value.action : "",
      settings: payload.settings,
    };
  } catch {
    return { id: "", settings: undefined };
  }
}

function keySettings(settings: LimitBeaconSettings): object {
  return {
    basis: settings.basis,
    displayStyle: settings.displayStyle,
    resetStyle: settings.resetStyle,
    warningThreshold: settings.warningThreshold,
    criticalThreshold: settings.criticalThreshold,
  };
}

function globalSettings(settings: LimitBeaconSettings): object {
  return {
    refreshMinutes: settings.refreshMinutes,
    codexExecutable: settings.codexExecutable,
  };
}

function selectTab(selected: HTMLButtonElement): void {
  for (const button of tabButtons) {
    const active = button === selected;
    button.setAttribute("aria-selected", String(active));
    const panelId = button.getAttribute("aria-controls");
    if (panelId !== null) requiredElement(panelId).hidden = !active;
  }
}

function applyHostFont(raw: string): void {
  try {
    const info = JSON.parse(raw) as unknown;
    if (isRecord(info) && typeof info.application === "object" && isRecord(info.application)) {
      const font = info.application.font;
      if (typeof font === "string" && font.length > 0) document.documentElement.style.fontFamily = font;
    }
  } catch {
    // System font fallbacks remain active.
  }
}

function requiredElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing element: ${id}`);
  return element as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStatus(value: unknown): value is InspectorStatusId {
  return typeof value === "string" && [
    "connected", "codex-missing", "sign-in-required", "starting", "stale", "incompatible", "error",
  ].includes(value);
}
