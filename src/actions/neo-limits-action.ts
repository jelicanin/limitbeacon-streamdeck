import {
  action,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
  type DidReceiveSettingsEvent,
  type PropertyInspectorDidAppearEvent,
  type PropertyInspectorDidDisappearEvent,
  type SendToPluginEvent,
} from "@elgato/streamdeck";
import {
  normalizeNeoSettings,
  type NeoSettings,
} from "../domain/neo-settings.js";
import {
  selectUsageGroup,
  type UsageService,
  type UsageServiceState,
} from "../services/usage-service.js";
import {
  inspectorConnectionPayload,
  isInspectorRefreshCommand,
  type InspectorSender,
} from "../ui/inspector-connection.js";
import { renderNeo } from "../render/neo-renderer.js";

export type NeoTarget = {
  id: string;
  setFeedbackLayout(layout: string): Promise<void>;
  setFeedback(value: { canvas: string }): Promise<void>;
};
type VisibleNeo = {
  target: NeoTarget;
  settings: NeoSettings;
  state: UsageServiceState;
  unsubscribe: () => void;
  layoutReady: boolean;
  revision: number;
};

export class NeoLimitsController {
  readonly #visible = new Map<string, VisibleNeo>();
  readonly #writes = new Map<string, Promise<void>>();
  #inspector: { id: string; send: InspectorSender } | undefined;

  constructor(
    private readonly service: Pick<UsageService, "subscribe" | "refresh">,
  ) {}

  appear(target: NeoTarget, raw: unknown): void {
    this.disappear(target.id);
    const neo: VisibleNeo = {
      target,
      settings: normalizeNeoSettings(raw),
      state: { status: "idle", snapshot: null, error: null },
      unsubscribe: () => {},
      layoutReady: false,
      revision: 0,
    };
    this.#visible.set(target.id, neo);
    neo.unsubscribe = this.service.subscribe((state) => {
      neo.state = state;
      this.#render(neo);
    });
  }

  disappear(id: string): void {
    this.#visible.get(id)?.unsubscribe();
    this.#visible.delete(id);
    this.inspectorDisappeared(id);
  }

  settingsChanged(id: string, raw: unknown): void {
    const neo = this.#visible.get(id);
    if (!neo) return;
    neo.settings = normalizeNeoSettings(raw);
    this.#render(neo);
  }

  inspectorAppeared(id: string, send: InspectorSender): void {
    this.#inspector = { id, send };
    const neo = this.#visible.get(id);
    if (neo) this.#sendStatus(neo);
  }

  inspectorDisappeared(id: string): void {
    if (this.#inspector?.id === id) this.#inspector = undefined;
  }

  async refresh(): Promise<void> {
    // UsageService publishes the failure; Neo has no showAlert command.
    await this.service.refresh().catch(() => {});
  }

  #sendStatus(neo: VisibleNeo): void {
    if (this.#inspector?.id !== neo.target.id) return;
    void this.#inspector
      .send(
        inspectorConnectionPayload(
          selectUsageGroup(neo.state, neo.settings.limitGroupId),
        ),
      )
      .catch(() => {});
  }

  #render(neo: VisibleNeo): void {
    if (this.#visible.get(neo.target.id) !== neo) return;
    this.#sendStatus(neo);
    const revision = ++neo.revision;
    const current = () =>
      this.#visible.get(neo.target.id) === neo && neo.revision === revision;
    const canvas = `data:image/svg+xml,${encodeURIComponent(renderNeo(neo.state, neo.settings))}`;
    // A reappearing instance waits for the previous instance's in-flight writes.
    const operation = (this.#writes.get(neo.target.id) ?? Promise.resolve())
      .then(async () => {
        if (!current()) return;
        if (!neo.layoutReady) {
          await neo.target.setFeedbackLayout("layouts/neo-limits.json");
          neo.layoutReady = true;
        }
        if (current()) await neo.target.setFeedback({ canvas });
      })
      .catch(() => {
        neo.layoutReady = false; // Retry layout on the next update after a host failure.
      });
    this.#writes.set(neo.target.id, operation);
    void operation.then(() => {
      if (this.#writes.get(neo.target.id) === operation)
        this.#writes.delete(neo.target.id);
    });
  }
}

@action({ UUID: "com.jelicanin.limitbeacon.neo-limits" })
export class NeoLimitsAction extends SingletonAction<NeoSettings> {
  constructor(
    private readonly controller: NeoLimitsController,
    private readonly send: InspectorSender,
  ) {
    super();
  }
  override onWillAppear(ev: WillAppearEvent<NeoSettings>): void {
    if (ev.action.isNeoInfobar())
      this.controller.appear(ev.action, ev.payload.settings);
  }
  override onWillDisappear(ev: WillDisappearEvent<NeoSettings>): void {
    this.controller.disappear(ev.action.id);
  }
  override onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<NeoSettings>,
  ): void {
    this.controller.settingsChanged(ev.action.id, ev.payload.settings);
  }
  override onPropertyInspectorDidAppear(
    ev: PropertyInspectorDidAppearEvent,
  ): void {
    this.controller.inspectorAppeared(ev.action.id, this.send);
  }
  override onPropertyInspectorDidDisappear(
    ev: PropertyInspectorDidDisappearEvent,
  ): void {
    this.controller.inspectorDisappeared(ev.action.id);
  }
  override async onSendToPlugin(
    ev: SendToPluginEvent<{ command?: string }, NeoSettings>,
  ): Promise<void> {
    if (isInspectorRefreshCommand(ev.payload)) await this.controller.refresh();
  }
}
