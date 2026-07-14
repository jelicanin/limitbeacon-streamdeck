# LimitBeacon Privacy

LimitBeacon runs locally as a Stream Deck plugin.

## Data it reads

LimitBeacon launches the official local `codex app-server` process and requests current usage limits through `account/rateLimits/read`. It uses the returned percentages, reset times, window presence, and plan label only to render the Stream Deck key and Property Inspector status.

## Data it stores

Stream Deck stores the display and connection preferences selected in the Property Inspector. LimitBeacon keeps the most recent successful usage snapshot in memory while the plugin is running so temporary failures can show stale data. It does not write usage snapshots to disk.

## Data it does not access

LimitBeacon does not read or modify Codex authentication files, browser cookies, refresh tokens, keychain or credential-manager entries. It does not call private ChatGPT endpoints. Authentication and any service communication remain the responsibility of the official Codex process.

## Telemetry and third parties

LimitBeacon has no analytics, telemetry, advertising, crash-reporting service, or project-operated server. It does not send data to the developer. The Property Inspector includes links to official Codex documentation; a link is opened only when the user selects it.

## Uninstalling

Uninstalling LimitBeacon removes the plugin. Stream Deck controls deletion of its saved plugin settings. LimitBeacon does not change the Codex login state during installation, use, or removal.
