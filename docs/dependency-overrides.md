# Dependency overrides

`@elgato/utils` 0.6.2 declares Zod 3, which includes an affected version of
the Zod 4 mini API used by that package. LimitBeacon overrides only this
dependency to Zod 4.6.6 to address
[GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).

This override is outside Elgato's declared dependency range. Elgato's current
utility modules import `zod/v4-mini`, which Zod 4.6.6 exports. The project's
Node 24 checks, SDK lifecycle contract, and package validation must pass with
the locked override. These checks do not replace Windows, physical-device, or
future SDK compatibility testing.

Reassess this override whenever the Stream Deck SDK or Elgato utils changes.
Remove it when upstream provides a compatible fixed dependency, then rerun the
dependency audit and all supported-platform checks.
