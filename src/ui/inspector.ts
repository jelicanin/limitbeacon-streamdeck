import { normalizeSettings, type LimitBeaconSettings } from "../domain/settings.js";
import { normalizeDialSettings, type DialSettings } from "../domain/dial-settings.js";
import { normalizeNeoSettings } from "../domain/neo-settings.js";
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
const lastSuccess = requiredElement("last-success");
const connectionTest = requiredElement<HTMLButtonElement>("test-connection");
const groupSelect = requiredElement<HTMLSelectElement>("limit-group");
let selectedGroupId = "";
let groupOptions: { id: string; label: string; available: boolean }[] = [];
let groupsReceived = false;
const thresholdError = requiredElement("threshold-error");
const tabButtons = document.querySelectorAll<HTMLButtonElement>("[role=tab]");
const keySettingNames = new Set([
  "basis", "displayStyle", "resetStyle", "warningThreshold", "criticalThreshold", "limitGroupId", "window",
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
    detail: "Review credits and spend for the automatic group, plus account-wide reset credits.",
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
let isNeoInspector = false;
let neoSettings = normalizeNeoSettings(undefined);
let specializedDial: { title: string; detail: string; controls: string } | undefined;
let dialSettings = normalizeDialSettings(undefined);

window.connectElgatoStreamDeckSocket = (port, inspectorId, registerEvent, info, actionInfo) => {
  propertyInspectorId = inspectorId;
  const action = readActionInfo(actionInfo);
  actionId = action.id;
  isBrowserDialInspector = action.id === DIAL_ACTION_ID;
  isNeoInspector = action.id === "com.jelicanin.limitbeacon.neo-limits";
  specializedDial = SPECIALIZED_DIALS.get(action.id);
  isDialInspector = isBrowserDialInspector || specializedDial !== undefined;
  configureInspector();
  if (isNeoInspector) setNeoForm(action.settings);
  else if (isBrowserDialInspector) setDialForm(action.settings);
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
  button.tabIndex = button.getAttribute("aria-selected") === "true" ? 0 : -1;
  button.addEventListener("click", () => selectTab(button));
  button.addEventListener("keydown", (event) => {
    const buttons = Array.from(tabButtons);
    const index = buttons.indexOf(button);
    const targetIndex = event.key === "ArrowRight" ? (index + 1) % buttons.length
      : event.key === "ArrowLeft" ? (index - 1 + buttons.length) % buttons.length
      : event.key === "Home" ? 0
      : event.key === "End" ? buttons.length - 1
      : null;
    if (targetIndex === null) return;
    const target = buttons[targetIndex];
    if (target === undefined) return;
    event.preventDefault();
    selectTab(target);
    target.focus();
  });
}

connectionTest.addEventListener("click", () => {
  send({ event: "sendToPlugin", action: actionId, context: propertyInspectorId, payload: { command: "refresh" } });
  selectTab(requiredElement<HTMLButtonElement>("general-tab"));
});

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
  if (name === "limitGroupId") selectedGroupId = groupSelect.value;
  if (isNeoInspector && (name === "limitGroupId" || name === "window")) {
    neoSettings = normalizeNeoSettings({limitGroupId:selectedGroupId,
      window:requiredElement<HTMLSelectElement>("quota-window").value});
    send({event:"setSettings", action:actionId, context:propertyInspectorId, payload:neoSettings});
    return;
  }
  if (isBrowserDialInspector && (name === "displayStyle" || name === "limitGroupId")) {
    dialSettings = { ...dialSettings, displayStyle: selectedDisplayStyle(), limitGroupId: selectedGroupId };
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
  if (!isDialInspector && !isNeoInspector && keySettingNames.has(name)) {
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
      if (isNeoInspector) setNeoForm(payload.settings);
      else if (isBrowserDialInspector) setDialForm(payload.settings);
      else if (specializedDial === undefined) setKeyForm(payload.settings);
    }
    if (message.event === "didReceiveGlobalSettings") setGlobalForm(payload.settings);
    if (message.event === "sendToPropertyInspector" && isStatus(payload.status)) {
      if (Array.isArray(payload.limitGroups)) {
        groupOptions = payload.limitGroups.filter((group): group is {id: string; label: string; available: boolean} =>
          isRecord(group) && typeof group.id === "string" && group.id.length > 0 && group.id.length <= 256
          && typeof group.label === "string" && group.label.length <= 80 && typeof group.available === "boolean");
        groupsReceived = true;
        renderGroupOptions();
      }
      renderStatus(payload.status);
      const timestamp = payload.lastSuccessAt;
      const valid = typeof timestamp === "number" && timestamp >= 0 && Number.isFinite(new Date(timestamp).getTime());
      lastSuccess.hidden = !valid;
      lastSuccess.textContent = valid ? `Last successful update: ${new Date(timestamp).toLocaleString()}` : "";
    }
  } catch {
    // Ignore malformed host messages and keep the inspector usable.
  }
}

function setNeoForm(raw: unknown): void {
  neoSettings = normalizeNeoSettings(raw);
  selectedGroupId = neoSettings.limitGroupId;
  renderGroupOptions();
  setField("window", neoSettings.window);
}

function setDialForm(raw: unknown): void {
  dialSettings = normalizeDialSettings(raw);
  selectedGroupId = dialSettings.limitGroupId;
  renderGroupOptions();
  setField("displayStyle", dialSettings.displayStyle);
}

function selectedDisplayStyle(): DialSettings["displayStyle"] {
  return new FormData(form).get("displayStyle") === "bars" ? "bars" : "rings";
}

function configureInspector(): void {
  if (isDialInspector || isNeoInspector) {
    for (const element of document.querySelectorAll<HTMLElement>("[data-key-only]")) {
      element.hidden = true;
    }
  }
  const guideContent = isNeoInspector ? {
    title:"Neo Limits", detail:"Show a limit group's remaining quota, reset countdown, and connection state.",
    controls:"Neo Infobar is display-only. Choose its group and window here; use Refresh now to retry.",
  } : specializedDial;
  requiredElement("quota-window-field").hidden = isDialInspector;
  if (guideContent !== undefined) {
    requiredElement("limit-group-field").hidden = !isNeoInspector;
    for (const element of document.querySelectorAll<HTMLElement>("[data-configurable-display]")) {
      element.hidden = true;
    }
    const guide = requiredElement("specialized-guide");
    guide.hidden = false;
    requiredElement("specialized-guide-title").textContent = guideContent.title;
    requiredElement("specialized-guide-detail").textContent = guideContent.detail;
    requiredElement("specialized-guide-controls").textContent = guideContent.controls;
    const help = requiredElement("specialized-help");
    help.hidden = false;
    requiredElement("specialized-help-title").textContent = `${guideContent.title} controls`;
    requiredElement("specialized-help-copy").textContent = guideContent.controls;
  }
}

function setKeyForm(raw: unknown): void {
  const settings = normalizeSettings(raw);
  selectedGroupId = settings.limitGroupId;
  renderGroupOptions();
  setField("window", settings.window);
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
      limitGroupId: selectedGroupId,
      window: data.get("window") ?? "automatic",
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
  connectionTest.disabled = id === "starting";

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
    limitGroupId: settings.limitGroupId,
    window: settings.window,
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
    button.tabIndex = active ? 0 : -1;
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
    "connected", "group-unavailable", "codex-missing", "sign-in-required", "starting", "stale", "incompatible", "error",
  ].includes(value);
}

function renderGroupOptions(): void {
  groupSelect.replaceChildren();
  const add = (id: string, label: string) => {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = label;
    groupSelect.append(option);
  };
  add("", "Automatic");
  for (const group of groupOptions) add(group.id, group.available ? group.label : `${group.label} (unavailable)`);
  if (selectedGroupId !== "" && !groupOptions.some(group => group.id === selectedGroupId)) {
    add(selectedGroupId, groupsReceived ? "Selected group (unavailable)" : "Selected group");
  }
  groupSelect.value = selectedGroupId;
}
