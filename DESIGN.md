# Design

## Authority

Existing DSH shell and settings are the visual authority. This is a local functional extension, not a redesign. User confirmed code-first and a URL/key gate before loading the original management page. No custom typography required. The icon reuses Magpie's original small-size SVG silhouette; only currentColor and component sizing are applied, with MIT attribution in THIRD-PARTY-NOTICES.

## Composition

- Native sidebar.panellist entry + keyed main panel; preserve workspace navigation.
- Native settings.section entry with a single vertical form, labelled URL and password inputs, advanced fields collapsed by default, explicit gateway-Key creation consent, one connect action.
- Connection evidence is a textual status plus dot; discovered providers use simple separated rows, no dashboard cards.
- Original Magpie page loads lazily in DSH's managed native webview only for a configured connection. User explicitly requires a chrome-free surface: show only original backend content, no connector heading, connection badge, toolbar, status strip or added top padding. Loading is silent; failures replace the content area with a short error and retry action, never a permanent header. Connection management stays in DSH settings. No automatic iframe/external downgrade.
- Composer contribution matches Codex subscription chrome: compact transparent stats-style pill (original icon + supplier name and quota only, no repeated Magpie text) and a trigger-anchored dialog, 16px menu radius, token shadow, 4px quota bars. Dialog surface explicitly strips alpha from the theme menu color with relative RGB /1 and an opaque base fallback; never allow content behind to impair readability. Render only for the exact selected Magpie route; show its upstream supplier alone. Dialog states current model and supplier-merged scope, with no account list and abnormal accounts excluded. Same-label/unit/pool metrics aggregate only: known counts weighted by summed totals, unknown capacities as explicitly labelled equal-weight mean. Compact pill shows shortest-period next-reset countdown and per-cycle shares (`2h15m | 5h60% · 1w40%`), no remaining suffix or min–max range. Popup keeps separate cycles, explicit mean/total semantics, distinct reset clocks and cached read time. Never imply quota belongs exclusively to this model or that the next account is known. Escape, outside click and close dismiss; a model switch closes immediately. Model state uses the shared SDK observable, not a brand heuristic.

## Tokens and Behavior

Use --dsw-alias-* backgrounds, labels, borders, business/error/success and hover colors, inherited system font, 8px form controls and explicit keyboard outline. No host-wide CSS overrides. DSH rc.5 settings navigation has no public icon field, so a narrowly scoped, disposable DOM adapter replaces only the exact Magpie settings row SVG with the same original silhouette; it preserves other settings icons and restores original nodes on unload. Responsive narrow viewport wraps header actions and retains labelled controls without horizontal overflow.

Credential text is never populated back into inputs. Same URL can retain host-side key when field is blank. No long-lived key or launch token in any href/src; only an ephemeral owner-RPC descriptor is passed as native POST bytes. Disconnect requires inline confirmation and describes local-only removal.

## Verification

Code-first light desktop + dark narrow fixture render reviewed; setup, connected, native container creation/POST request, unsupported capability and disconnect behavior covered by Playwright mocks. Fixture uses representative DSH token values and mocked data, not live user credentials or a screenshot of the authenticated current GUI. Mechanical detector reported no findings. Full live host navigation remains a separate acceptance check after DSH reload/authentication.
