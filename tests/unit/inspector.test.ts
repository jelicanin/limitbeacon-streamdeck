import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { build } from "esbuild";

const html = await readFile(new URL("../../com.jelicanin.limitbeacon.sdPlugin/ui/index.html", import.meta.url), "utf8");
const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../../src/ui/inspector.ts", import.meta.url))],
  bundle: true, write: false, platform: "browser", format: "iife", target: "es2022",
});

// Only the DOM and Stream Deck socket boundary are faked; the actual inspector bundle runs below.
class Element extends EventTarget {
  attributes = new Map<string, string>();
  children: Element[] = [];
  textContent = "";
  hidden = false;
  disabled = false;
  value = "";
  style = { fontFamily: "" };
  focused = false;
  constructor(readonly tag: string) { super(); }
  get name(): string { return this.attributes.get("name") ?? ""; }
  get href(): string { return this.attributes.get("href") ?? ""; }
  set href(value: string) { this.attributes.set("href", value); }
  get tabIndex(): number { return Number(this.attributes.get("tabindex") ?? 0); }
  set tabIndex(value: number) { this.attributes.set("tabindex", String(value)); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  append(element: Element): void { this.children.push(element); }
  replaceChildren(): void { this.children = []; }
  focus(): void { this.focused = true; }
  click(): void { this.dispatchEvent(new Event("click", { cancelable: true })); }
}
class Input extends Element {}
class RadioList { value = ""; }

function setup(actionName = "codex-limits") {
  const nodes: Element[] = [];
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/giu)) {
    const tag = match[1]!;
    const element = tag === "input" || tag === "select" ? new Input(tag) : new Element(tag);
    for (const attr of match[2]!.matchAll(/([\w-]+)(?:="([^"]*)")?/gu)) {
      element.setAttribute(attr[1]!, attr[2] ?? "");
    }
    element.hidden = element.attributes.has("hidden");
    element.value = element.getAttribute("value") ?? "";
    nodes.push(element);
  }
  const matches = (element: Element, selector: string): boolean => {
    if (selector.startsWith(".")) return element.getAttribute("class")?.split(" ").includes(selector.slice(1)) ?? false;
    const attribute = /^\[([^=\]]+)(?:=([^\]]+))?\]$/u.exec(selector)!;
    return attribute[2] === undefined ? element.attributes.has(attribute[1]!) : element.getAttribute(attribute[1]!) === attribute[2];
  };
  const byId = (id: string) => nodes.find(node => node.getAttribute("id") === id)!;
  const form = byId("settings-form") as Element & { elements: { namedItem(name: string): Element | RadioList | null } };
  form.elements = {
    namedItem(name) {
      const fields = nodes.filter(node => node.name === name);
      return fields.length > 1 ? new RadioList() : fields[0] ?? null;
    },
  };
  const sent: Record<string, unknown>[] = [];
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 1;
    constructor(_url: string) { super(); socket = this; }
    send(message: string): void { sent.push(JSON.parse(message)); }
  }
  let socket!: Socket;
  const window = {} as { connectElgatoStreamDeckSocket: (...args: string[]) => void };
  runInNewContext(bundle.outputFiles[0]!.text, {
    window, document: {
      getElementById: byId,
      querySelector: (selector: string) => nodes.find(node => matches(node, selector)),
      querySelectorAll: (selector: string) => nodes.filter(node => matches(node, selector)),
      createElement: (tag: string) => new Element(tag),
      documentElement: nodes[0],
    },
    WebSocket: Socket, HTMLInputElement: Input, HTMLSelectElement: Input, RadioNodeList: RadioList,
  });
  window.connectElgatoStreamDeckSocket("12345", "inspector-1", "registerPropertyInspector", "{}", JSON.stringify({
    action: `com.jelicanin.limitbeacon.${actionName}`, payload: { settings: {} },
  }));
  socket.dispatchEvent(new Event("open"));
  return {
    byId, sent, nodes,
    receive(payload: unknown) {
      socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({event: "sendToPropertyInspector", payload}) }));
    },
  };
}

for (const action of ["limit-browser", "daily-tokens", "credits-spend", "activity-stats"]) {
  test(`${action} exposes connection failures and sends Retry to its own action`, () => {
    const host = setup(action);
    host.receive({ status: "error" });
    const status = host.nodes.find(node => node.getAttribute("class") === "status")!;
    assert.equal(status.hidden, false);
    assert.equal(host.byId("status-title").textContent, "Could not refresh");
    host.byId("status-action").children[0]!.click();
    assert.deepEqual(host.sent.at(-1), {
      event: "sendToPlugin", action: `com.jelicanin.limitbeacon.${action}`, context: "inspector-1", payload: {command: "refresh"},
    });
  });
}

test("tabs support roving focus, arrows with wrapping, Home and End", () => {
  const host = setup();
  const general = host.byId("general-tab");
  const advanced = host.byId("advanced-tab");
  const help = host.byId("help-tab");
  assert.equal(general.tabIndex, 0);
  assert.equal(advanced.tabIndex, -1);
  assert.equal(help.tabIndex, -1);
  const press = (tab: Element, key: string) => {
    const event = new Event("keydown", {cancelable: true});
    Object.defineProperty(event, "key", {value: key});
    tab.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
  };
  press(general, "ArrowLeft");
  assert.equal(help.getAttribute("aria-selected"), "true");
  assert.equal(help.focused, true);
  assert.equal(host.byId("help-panel").hidden, false);
  assert.equal(host.byId("general-panel").hidden, true);
  assert.equal(general.tabIndex, -1);
  press(help, "ArrowRight");
  assert.equal(general.getAttribute("aria-selected"), "true");
  press(general, "End");
  assert.equal(help.getAttribute("aria-selected"), "true");
  press(help, "Home");
  assert.equal(general.getAttribute("aria-selected"), "true");
  advanced.click();
  assert.equal(advanced.tabIndex, 0);
  assert.equal(host.byId("advanced-panel").hidden, false);
});
