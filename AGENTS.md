# LimitBeacon project rules

## Scope and approval

- This repository is `jelicanin/limitbeacon-streamdeck`. Distribution channels are GitHub Releases and the Elgato Marketplace. Confirm the checkout, branch, version, and intended channel before release work.
- Read [RELEASING.md](RELEASING.md) before preparing a package, release, or Marketplace handoff.
- Present a concrete plan and obtain approval before making changes. A direct request to prepare local changes authorizes that preparation only. Show the resulting diff before requesting publication approval.
- Commit, push, PR creation, PR merge, tag creation/push, GitHub Release publication, and Marketplace submission require explicit approval covering those specific operations. One approval may cover several named operations; do not ask again within an already approved scope. Never infer publication approval from approval to test or prepare a package.
- Do not post GitHub comments or other external messages without explicit authorization. Preserve unrelated work. Keep assistant-only plans and verification records in gitignored `.local/`.

## Release closure

- Every release handoff must account for the reviewed commit, local checks, PR review/CI, merged-commit CI, annotated remote tag, GitHub Release, installer checksum, and Marketplace handoff. Use the checklist in RELEASING.md; no silent omissions.
- If a required step lacks approval, finish the authorized preparation, show the exact version, commit, assets, and proposed operation, then ask for that approval. Do not stop at a package and describe the release as complete.
- If the user reports a Marketplace upload or publication, reconcile that exact version against its GitHub tag, Release, and installer. Report any gap and request the missing authorization; never silently leave the channels inconsistent.
- A local package, successful CI, merged PR, published GitHub Release, Marketplace submission, and Marketplace publication are separate facts. State only what the available evidence proves, with links or file paths and the verification date.
- Public release notes describe features, fixes, compatibility, and known product limitations. Keep submission/review status in the private release record and user handoff, not in public release notes unless requested.
- Never move an existing release tag, replace published installer bytes, invent a historical date, or reuse a published version for changed code. Follow the historical-release rules in RELEASING.md.

## Verification and presentation

- Use Node.js 24 and the committed lockfile. The local gates are `npm run check` on macOS/Windows and `npm run check:portable` on Linux. Apply the global security-scan requirements before the relevant Git operations.
- Report automated checks, local previews, live Codex integration checks, and physical-device acceptance separately. A Neo preview does not prove physical Neo acceptance.
- Promo images must match implemented behavior: one usage window, one percentage, and one progress indicator per key. Identify mockups and obtain visual approval before publication.
- Checked-in documentation, comments, and release notes are English. User-facing Croatian/Serbian/Bosnian replies use Latin script unless explicitly requested otherwise.
