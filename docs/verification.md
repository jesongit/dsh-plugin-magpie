# Verification — 2026-11-02

## Latest — merged quotas and per-cycle compact badge

- No account list in popup. Exclude unavailable/error accounts; merge only identical window kind/name/pool/unit. Known count totals sum before deriving share; percent-only readings use explicitly labelled equal-weight mean. Different cycles/units stay separate, duplicate same-account metric omitted, shared/unstructured balances never guessed or double-counted.
- Compact badge uses shortest-recognized-cycle next-reset countdown and separate cycle percentages: `2h15m | 5h60% · 1w40%`. No remaining suffix, no min–max range. Popup does not imply the whole pool resets together; differing member resets explicitly say individual reset times. Clock updates share existing one-minute snapshot timer.
- **109/109** offline tests plus strict build pass. Desktop/narrow fixture includes two normal and one abnormal account: popup meters60/40, abnormal excluded, no account names; compact5h60% and1w40%; opacity regression passes. Real GUI acceptance remains after refresh; fixture uses synthetic data.

## Previous — selected-model quota popup

- Replaced global composer overview with an exact selected-route gate: no Magpie model selected means no badge/dialog. Current SDK model directory observable drives immediate provider/model changes; legacy no-store host uses subscriber-only 3s fallback.
- Codex-style compact transparent pill opens a trigger-anchored menu-token dialog for only the matching upstream supplier, with current full model ID and explicit supplier-shared quota scope. Anonymous account snapshots use percentage/count bars, balance/credits, and text/unlimited/unknown states; never claim actual routing account or per-model allowance not supplied upstream.
- Kept snapshot parser allowlists and bounds public fields, redacts account identity/raw errors/secrets, preserves absolute read/reset times and stale state, and never invents percentage for text/balance. Quota calls remain kept=1 shared-cache only.
- Desktop and narrow/dark Playwright fixture validates hidden direct model, Codex-only popup, WorkBuddy credits/text/unlimited, model switch auto-close, Escape dismissal, bounds/no overflow, plus prior retained-container checks. Captures are mocked data, not current authenticated GUI evidence. Mechanical detector returned [].
- Full strict build and **97/97** offline tests passed; compiled client registration smoke accepts ReactDOM and five native slots. Real current-GUI model selection/render remains user acceptance after refresh; no upstream/vendor/account mutation executed.

## Previous — retained native surface performance

- User confirmed the launch/navigation fix works in the actual GUI, including returning from other tabs.
- Replaced transient-panel guest ownership with one lazy native guest in additive shell.overlay. Main panel is geometry anchor only. Twelve fixture panel switch cycles retain exact same webview DOM with one ticket issue/one POST/zero releases, preserving page state; hidden surface is inert, noninteractive and absent from tab flow. Disconnect releases the guest.
- Matching Electron44.7 actual controller verified 12 visibility/inert cycles preserve guest webContents identity and in-page JavaScript state, no repeated login/network requests. Existing 307/308 cross-origin sink remained zero requests. Synthetic evidence, not an FPS claim about the real Magpie page.
- Removed per-event diagnostic RPC and file writing after diagnosis; repeated post-ready load notifications return immediately, without native URL reads. No guest DOM rewrite, no DSH/Magpie core changes, no expiry/relogin added.
- Full suite now **80/80** passes, including retained-surface and connection-generation coverage. Retention trades one live page's memory for instant reuse; upstream timers/polling remain owned by Magpie.

## Previous — managed native launch (phase 1/2)

This section supersedes historical iframe evidence below. Panel now mounts a DSH-managed native webview, not an iframe. Blank guest first performs a keyless exact management-root GET (401 login page or 200 existing session allowed), then issues and consumes a 30s, crypto-32-byte single-use ticket on existing owner-auth RPC. A fixed one-shot guest script rechecks its own exact location and performs same-origin fetch POST with redirect manual. Native loadURL then GETs the clean root; no credential-bearing native navigation POST. No launch proxy/guest DSH URL, no credentials/token in URL, no DSH cookie given to guest. No expiry detection or automatic relogin implemented.

- Latest follow-up strict build passed; **72/72** mocked/offline tests passed, including 8 launch and 19 native lifecycle cases. Fixed repeated/delayed blank DOM-ready prematurely authenticating before root navigation, requiring both main 200/401 commitment and root DOM-ready. Root fragment-only changes are tolerated; query/path/origin still rejected.
- User-requested chrome-free panel: removed connector header, status strip, controls and top padding. Normal configured view is only native backend content. Connection management stays in DSH settings; failures offer in-content retry. Desktop/narrow fixture assertions check there is no panel header, note or normal toolbar. Latest real-native run loaded root401 then root200, but secondary API probe still returned no status and the aggregate test exit was1; full live GUI confirmation remains pending. Refreshed the verified existing DSH window without Host restart.
- Actual Electron **44.7.0** (same installed binary version), isolated synthetic fixture: sandbox=true, contextIsolation=true, nodeIntegration=false; the actual bundled native controller passed GET401 → fixed manual-fetch POST303 → HttpOnly/SameSite=Lax Cookie → clean GET200 readiness. Additional 307 and 308 redirects to a second origin received **zero requests** at that sink; both fail closed instead of forwarding the key. Initial raw native POST experiment passed compatibility but was replaced after review identified redirect-body leakage. Test runtime was a separate local copy, no running DSH files/resources/cookies copied or modified; fixture server closed on exit. No real Magpie model/key changes in this phase.
- Playwright actual React UI with mocked native bridge: desktop/narrow gate, exactly one issue/redeem/POST, no iframe, blank bootstrap URL only, explicit retry via remount, disconnect lease release, no horizontal overflow/page exceptions. Non-desktop path gives requirement notice and creates neither iframe/webview nor launch token. Captures desktop-native/mobile-native are clearly synthetic, not real Magpie screenshots.
- Mechanical UI detector returned [].
- Management key temporarily transits trusted app renderer memory as the consumed RPC POST descriptor, but never public snapshots, storage, URL, model context or diagnostic text. Documentation updated to remove earlier host-only and manual-login claims.
- Real Magpie with authorized local test credentials in the isolated matching native runtime: actual controller navigated management root 401 → manual login → management root 200, confirming automatic authenticated homepage load without manual input. A separate guest-script providers API check was inconclusive (no returned status), so full API/community-page interaction is not asserted. Credentials were not printed or copied into defaults; no model/account/key mutation was performed.
- Actual existing authenticated DSH window with live configured Magpie remains a separate acceptance check. Unauthenticated GUI HTTP is 401; no attempt to bypass authentication or extract cookies. Native host lease policy source verified, not modified. Host restrictions on downloads/popups remain; no claim of all OAuth/community-page compatibility.

## Historical first-version verification

## Environment

- Independent package dsh-plugin-magpie 0.1.0; DSH SDK 0.2.1-rc.5 / Cordis 4.0.5 / managed Node 24.21.0.
- Magpie workspace tracked sources unchanged. Existing deploy directory and user-created .env remain untouched.
- No fixed Magpie frontend or browser engine included. Current compiled browser module is about 31.2 kB (gzip about 9.4 kB) with the original Magpie SVG; all emitted JS about 119 kB, excluding host peers, maps and development dependencies. Not a measured RAM claim.

## Build and automated tests

- `pnpm run build`: passed (strict TypeScript + standalone DSH closure-factory browser bundle).
- `node --experimental-strip-types --test test/*.test.ts`: **45/45 passed**.
- Coverage includes fake management login and create/revoke failures, credentials not reused across URL changes, cached catalog on failure, immutable call targets, malformed SSE, text/reasoning/tools/images/usage, cancellation, actual LlmRuntime register/replace, RPC consent validation, client late-response races and persistence commit/cancellation.
- Read-only security/lifecycle review found two P2 issues (late client responses; cancellation after disk commit). Both fixed with regression coverage; no other confirmed P1/P2 findings in that review.

## Real Magpie test — explicitly authorized

User supplied a local test configuration; test runners consumed its values without printing or copying them to source/default settings. The supplied URL was the model gateway port, while the supplied secret was the backend page key. The documented management port was used for the authorized test; original test file was not edited.

- Management form login: passed; providers and model metadata readable.
- Temporary gateway key: created only after explicit user authorization, enabled, used for directory + exactly one short model request, then removed.
- Parsed provider directory: routing group 1, Kimi 1, Codex 3, ZCode 1, WorkBuddy 4, Qoder CN 4 — 14 models total, six displayed groups including routing.
- One request through MagpieAdapter to `codex/gpt-6-astra`: text and usage returned, terminal finish valid. No account pin, no route/account/sharing change.
- Temporary key deletion followed by list check: absence verified.
- No real connection credentials persisted into plugin defaults; formal setup remains UI-only.

## Browser fixture review

Playwright Chromium rendered the actual connector React components in a fixture with representative DSH alias tokens, mocked RPC, light desktop 1280×960 and dark narrow 390×844.

Passed: configuration gate before iframe, labelled form, connection and provider rows, clearing password fields after save, iframe/external URL without key, inline disconnect confirmation, no horizontal overflow, no page exceptions. Screenshots reviewed in one batched pass; no visual defects required a layout redesign. Fixture navigation bug in first verification script was corrected (a successful setup in main panel intentionally transitions to the frame).

Impeccable mechanical detector: no findings. No generated/shipping raster assets. After the user's icon request, the original Magpie small SVG path was reused byte-for-byte in the component with currentColor, attribution added, and desktop/mobile captures repeated. The compiled module factory was additionally loaded against actual SlotCore declarations; all four native slot registrations passed.

## Current DSH host installation

Installed via desktop application's official CLI into `desktop` profile as a local link. Bundle list includes dsh-plugin-magpie; existing bundles and manually added models untouched. Compiled plugin is ready for load/reload.

Current existing GUI `http://127.0.0.1:57954` was checked from an independent browser context and rejects unauthenticated requests with 401. No attempt was made to bypass authentication, obtain browser cookies, or restart the active session. Thus current authenticated GUI navigation, real inline settings save, real iframe login/embedded community pages and actual memory performance are **not yet verified**. Reload plugin/restart DSH then refresh page and complete UI setup for final live-host acceptance. No replacement server was started.

## Follow-up — settings navigation icon and refresh request

The settings shell uses a closed built-in icon map and provides no icon option. A narrowly scoped compatibility adapter now changes only the exact Magpie row within the settings dialog to the original silhouette. Original SVG nodes/attributes are restored on unload; other settings icons are untouched; the observer ignores conversation mutation bursts. Build + 45 offline tests passed. A separate browser regression passed mount/remount, original bird, unrelated icon preservation, and disposal restoration. Detector returned [].

At the user's explicit reload request, a temporary comment-only change notified the profile watcher and was then removed, leaving configuration semantics unchanged. A Ctrl+R refresh was sent after activating the verified existing DeepSeek Harness desktop process. Host/main process start times remained unchanged; GUI endpoint stayed online (401 without authentication). Renderer refresh/plugin activation is not independently observable from this unauthenticated context; awaiting user visual confirmation. No Host restart or replacement server.

