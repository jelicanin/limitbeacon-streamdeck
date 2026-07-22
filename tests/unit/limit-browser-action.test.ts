import assert from "node:assert/strict";
import test from "node:test";

import { LimitBrowserController } from "../../src/actions/limit-browser-action.js";
import type { UsageServiceState, UsageSubscriber } from "../../src/services/usage-service.js";

const readyState: UsageServiceState = {
  status: "ready",
  error: null,
  snapshot: {
    capturedAt: 1_000,
    fiveHour: {
      usedPercent: 20,
      remainingPercent: 80,
      durationMinutes: 300,
      resetsAt: null,
    },
    weekly: {
      usedPercent: 35,
      remainingPercent: 65,
      durationMinutes: 10_080,
      resetsAt: null,
    },
    planLabel: "plus",
    accountHealth: {
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      rateLimitReachedType: null,
      resetCreditsAvailable: null,
    },
    stale: false,
  },
};

const singleWindowState: UsageServiceState = {
  status: "ready",
  error: null,
  snapshot: {
    capturedAt: 1_000,
    fiveHour: {
      usedPercent: 45,
      remainingPercent: 55,
      durationMinutes: 10_080,
      resetsAt: null,
    },
    weekly: null,
    planLabel: "plus",
    accountHealth: {
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      rateLimitReachedType: null,
      resetCreditsAvailable: null,
    },
    stale: false,
  },
};

class FakeService {
  state: UsageServiceState = readyState;
  subscribers = new Set<UsageSubscriber>();
  refreshCount = 0;

  subscribe(subscriber: UsageSubscriber): () => void {
    this.subscribers.add(subscriber);
    subscriber(this.state);
    return () => this.subscribers.delete(subscriber);
  }

  async refresh(): Promise<UsageServiceState> {
    this.refreshCount += 1;
    return this.state;
  }
}

class FakeDial {
  readonly feedback: Array<Record<string, unknown>> = [];
  readonly settings: Array<Record<string, unknown>> = [];
  alertCount = 0;

  constructor(readonly id: string) {}

  async setFeedback(value: Record<string, unknown>): Promise<void> {
    this.feedback.push(value);
  }

  async setSettings(value: Record<string, unknown>): Promise<void> {
    this.settings.push(value);
  }

  async showAlert(): Promise<void> {
    this.alertCount += 1;
  }
}

function latestSvg(dial: FakeDial): string {
  const canvas = dial.feedback.at(-1)?.canvas;
  assert.equal(typeof canvas, "string");
  const image = canvas as string;
  assert.match(image, /^data:image\/svg\+xml,/u);
  return decodeURIComponent(image.slice("data:image/svg+xml,".length));
}

function feedbackSvg(feedback: Record<string, unknown>): string {
  const canvas = feedback.canvas;
  assert.equal(typeof canvas, "string");
  return decodeURIComponent((canvas as string).slice("data:image/svg+xml,".length));
}

function transitionSvgs(dial: FakeDial): string[] {
  return dial.feedback
    .map(feedbackSvg)
    .filter((svg) => svg.includes('class="incoming-page"'));
}

test("dial subscribes and initially shows the first available limit", () => {
  const service = new FakeService();
  const controller = new LimitBrowserController(service);
  const dial = new FakeDial("dial-1");

  controller.appear(dial, {});

  assert.equal(service.subscribers.size, 1);
  assert.match(latestSvg(dial), />5H · LEFT</u);
  assert.match(latestSvg(dial), />80%</u);
  controller.disappear(dial.id);
  assert.equal(service.subscribers.size, 0);
});

test("rotation browses limits independently for each dial", async () => {
  const service = new FakeService();
  const controller = new LimitBrowserController(service);
  const first = new FakeDial("first");
  const second = new FakeDial("second");
  controller.appear(first, {});
  controller.appear(second, {});

  await controller.rotate(first.id, 1);

  assert.match(latestSvg(first), />7D · LEFT</u);
  assert.match(latestSvg(second), />5H · LEFT</u);
  assert.deepEqual(first.settings.at(-1), {
    activeIndex: 1,
    basis: "remaining",
    displayStyle: "rings",
  });
});

test("rotation toggles remaining and used when only one limit is available", async () => {
  const service = new FakeService();
  service.state = singleWindowState;
  const controller = new LimitBrowserController(service);
  const dial = new FakeDial("dial-1");
  controller.appear(dial, {});

  await controller.rotate(dial.id, 1);

  assert.match(latestSvg(dial), />45%</u);
  assert.match(latestSvg(dial), />7D · USED</u);
  assert.deepEqual(dial.settings.at(-1), {
    activeIndex: 0,
    basis: "used",
    displayStyle: "rings",
  });
  const transitionFrames = transitionSvgs(dial);
  assert.equal(transitionFrames.length, 12);
  assert.match(transitionFrames[0] ?? "", />55%</u);
  assert.match(transitionFrames[0] ?? "", />45%</u);
});

test("counter-clockwise rotation brings the incoming page from the right", async () => {
  const service = new FakeService();
  service.state = singleWindowState;
  const controller = new LimitBrowserController(service);
  const dial = new FakeDial("dial-1");
  controller.appear(dial, {});

  await controller.rotate(dial.id, -1);

  assert.match(
    transitionSvgs(dial)[0] ?? "",
    /class="incoming-page" transform="translate\((?!-)\d/u,
  );
});

test("fast rotation coalesces pending ticks without overlapping animations", async () => {
  const service = new FakeService();
  service.state = singleWindowState;
  const controller = new LimitBrowserController(service);
  const dial = new FakeDial("dial-1");
  controller.appear(dial, {});

  const first = controller.rotate(dial.id, -1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = controller.rotate(dial.id, -1);
  const third = controller.rotate(dial.id, -1);
  await Promise.all([first, second, third]);

  assert.equal(transitionSvgs(dial).length, 12);
  assert.match(latestSvg(dial), />7D · USED</u);
});

test("touch toggles remaining and used for only that dial", async () => {
  const service = new FakeService();
  const controller = new LimitBrowserController(service);
  const dial = new FakeDial("dial-1");
  controller.appear(dial, {});

  await controller.touch(dial.id);

  assert.match(latestSvg(dial), />20%</u);
  assert.match(latestSvg(dial), />5H · USED</u);
  assert.deepEqual(dial.settings.at(-1), {
    activeIndex: 0,
    basis: "used",
    displayStyle: "rings",
  });
});

test("display style changes only the selected dial", () => {
  const service = new FakeService();
  const controller = new LimitBrowserController(service);
  const first = new FakeDial("first");
  const second = new FakeDial("second");
  controller.appear(first, {});
  controller.appear(second, {});

  controller.settingsChanged(first.id, { displayStyle: "bars" });

  assert.match(latestSvg(first), /class="dial-meter-fill"/u);
  assert.doesNotMatch(latestSvg(first), /class="dial-ring-fill"/u);
  assert.match(latestSvg(second), /class="dial-ring-fill"/u);
});

test("dial press refreshes shared usage without an alert", async () => {
  const service = new FakeService();
  const controller = new LimitBrowserController(service);
  const dial = new FakeDial("dial-1");
  controller.appear(dial, {});

  await controller.press(dial.id);

  assert.equal(service.refreshCount, 1);
  assert.equal(dial.alertCount, 0);
});

test("dial press shows refresh feedback before new usage arrives", async () => {
  let resolveRefresh!: (state: UsageServiceState) => void;
  const service = new FakeService();
  service.refresh = () => {
    service.refreshCount += 1;
    return new Promise<UsageServiceState>((resolve) => {
      resolveRefresh = resolve;
    });
  };
  const controller = new LimitBrowserController(service);
  const dial = new FakeDial("dial-1");
  controller.appear(dial, {});

  const refresh = controller.press(dial.id);
  assert.match(latestSvg(dial), />Refreshing</u);

  await Promise.resolve();
  resolveRefresh(service.state);
  await refresh;
  assert.match(latestSvg(dial), />5H · LEFT</u);
});
