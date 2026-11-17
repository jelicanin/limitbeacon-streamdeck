# Releasing LimitBeacon

This is the release checklist for maintainers and coding agents. A merged PR or a built installer does not finish the release process. Each unchecked step needs an explicit remaining action and owner in the handoff.

## Targets and approval

- Repository: <https://github.com/jelicanin/limitbeacon-streamdeck>
- GitHub Releases: <https://github.com/jelicanin/limitbeacon-streamdeck/releases>
- Marketplace: <https://marketplace.elgato.com/product/limitbeacon-7e0006fc-2499-4957-a7df-9c594c4712cf>
- Marketplace submission is performed by the maintainer unless explicitly delegated.

Before changes, present the concrete version, scope, and intended operations for approval. Prepare and verify locally before asking to commit/push/open a PR. Obtain approval covering merge, then approval covering the exact tag and GitHub Release; a prior approval explicitly covering those operations remains valid. Marketplace publication is a separate operation. Never publish comments or request external reviews without authorization.

Project-specific adaptation of the global small-project baseline: version metadata is updated in the reviewed PR, not in a new unreviewed commit on `main`. Release the verified merged commit. This Stream Deck project currently has no `npm run release` command or release-publishing workflow; the checklist below is manual, not an automated enforcement mechanism. No website/SSH deployment is involved.

## 1. Select and prepare the version

- [ ] Confirm the checkout, remote, branch, current version, and existing tags/Releases. Preserve unrelated local work; use an isolated clean source tree for release builds.
- [ ] Check Marketplace history and submissions before selecting a new SemVer version. Do not infer publication from commit dates or filenames. Do not reuse a version already distributed or submitted for different code.
- [ ] Update `package.json`, the matching root metadata in `package-lock.json`, and the plugin manifest together (`X.Y.Z` in npm metadata; `X.Y.Z.0` in the Stream Deck manifest).
- [ ] Prepare English release notes from the actual changes, including compatibility requirements and relevant product limitations. Update README claims that would become stale at publication. Review promo images separately before publishing them.

## 2. Verify, review, and merge

Use Node.js 24 with the committed lockfile:

```sh
npm ci
npm run check
```

Linux uses `npm run check:portable`; plugin startup is checked on supported hosts.

- [ ] Run available formatting checks first, then affected tests and integration checks. Do not claim a formatter ran if the project has none configured.
- [ ] Run the applicable global security gates: `gitleaks dir --redact .` before push; scan the verified unpushed commit range after committing. Run OSV for dependency changes and Semgrep for security-sensitive source changes. Triage findings before proceeding.
- [ ] Show the diff and local results; obtain approval to commit, push, and open the PR. Use Conventional Commits and verify the PR's existing labels.
- [ ] Check review findings against the exact PR head. Resolve actionable findings and revalidate affected behavior. State whether review was automated or human; do not invent reviewer approval.
- [ ] Verify all five CI jobs for that head: Ubuntu, Windows, macOS, OSV, and Gitleaks. A queued, skipped, cancelled, or running job is not a pass. Retain failed-attempt evidence when a justified rerun succeeds.
- [ ] Obtain merge approval, merge, and verify all five jobs again for the actual merged commit. Record the full commit SHA and CI URL.

## 3. Build the release artifact

- [ ] Build from a clean tree of that exact merged commit with Node.js 24 and `npm ci`; run `npm run check` on a supported host. Reuse a previously verified build only when its exact commit and artifact identity are established.
- [ ] Package with the locked local CLI, keeping output outside the source tree:

```sh
npx --no-install streamdeck pack com.jelicanin.limitbeacon.sdPlugin --output <release-output-directory>
```

- [ ] Name the installer `LimitBeacon-vX.Y.Z.streamDeckPlugin`. Validate the archive, embedded version, minimum Stream Deck version, action set, and absence of temporary previews or private data. Compare packaged code/assets with the clean build.
- [ ] Generate `SHA256SUMS.txt` for the exact installer bytes. Preserve this artifact for both GitHub and Marketplace; do not rebuild between channels without re-verifying and explaining any difference.
- [ ] Record physical-device tests and live Codex checks actually performed, including their version and date. Document unavailable hardware; local rendering tests are not physical acceptance.

## 4. Publish GitHub tag and Release

- [ ] Present the exact version, full commit SHA, release notes, installer filename, and SHA-256. Obtain approval covering tag creation/push and GitHub Release publication.
- [ ] Recheck the remote target and absence of the intended tag/Release. Create an annotated `vX.Y.Z` tag on the approved commit, then push only the approved refs without force. Push multiple approved tags atomically when backfilling history.
- [ ] Create the matching GitHub Release with `gh release create --verify-tag`, using a notes file. Attach the verified installer and `SHA256SUMS.txt`. Explicitly select the correct latest release; historical additions must not replace it.
- [ ] Verify the remote tag resolves to the approved commit and the Release is published with the expected notes and assets. Download the installer/checksum assets and compare their bytes/hashes with the verified local files. Save the Release URL and actual publication timestamp.

GitHub Releases and Marketplace approval have separate publication schedules. A stable GitHub release can be published independently; do not mark it prerelease solely because of Marketplace review. Keep Marketplace submission/review workflow status out of public release notes unless the maintainer requests it.

## 5. Marketplace handoff and closure

- [ ] Provide the exact `.streamDeckPlugin` installer, checksum, copy-paste release notes, and approved promotional assets. An outer handoff ZIP is not the installer to upload.
- [ ] Include the verified GitHub Release link in the handoff. If any GitHub step remains incomplete, state the exact missing step and request its approval instead of silently calling the release finished.
- [ ] Record the maintainer's submission confirmation separately from approval/public availability. When publication is reported, verify the exact version against accessible Marketplace evidence; if unavailable, label the status as maintainer-reported.
- [ ] Reconcile the published Marketplace version with the tag, GitHub Release, and installer record. Surface discrepancies immediately. Do not infer that Marketplace approval proves code quality or device acceptance.
- [ ] Close with evidence for each channel and any remaining owner/action. If follow-up is needed, agree who will check it; do not promise monitoring unless it has actually been authorized and configured.

Keep a private record in `.local/releases/vX.Y.Z/verification.md` using these fields:

| Item | Evidence to retain |
| --- | --- |
| Approval | Authorized operations and the user message that granted them |
| Source | Version, PR URL, reviewed head, merged SHA, tag target |
| Checks | Local commands/results, review findings, CI URLs and final conclusions |
| Artifact | Filename, size, SHA-256, build provenance, package validation |
| Acceptance | Live integration/device checks actually performed and limitations |
| GitHub | Release URL, publication time, downloaded asset verification |
| Marketplace | Submission/publication evidence, date, and source of confirmation |
| Remaining work | Exact action, owner, and missing approval or evidence |

Never put credentials, account data, private API responses, or signing material in this record. This record is evidence, not proof that an unchecked step passed.

## Historical releases and corrections

- Bind each historical tag to the verified original version commit. Preserve existing tags and published artifacts.
- Use original release notes and verified Marketplace dates where available. GitHub records the actual later publication time; do not falsify it or backdate tag creation.
- If an original installer is unavailable, publish source archives only and state that limitation. A reconstructed build requires a separately approved plan and must be identified as reconstructed.
- A code or installer-content correction after distribution requires a new version. Do not silently replace a public asset or move its tag. Any exceptional corrective action requires its own explicit approval and documented reason.
