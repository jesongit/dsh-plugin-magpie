# Magpie connector implementation contract

Independent DSH plugin; do not modify Magpie or DSH core. Primary runtime: DSH 0.2.1-rc.5, Node 24. Web UI inherits DSH native tokens/slots. Existing manually imported models remain untouched.

## Modules and ownership

- `src/contracts.ts`: shared JSON-only types, maintained by parent.
- `src/service.ts`, `src/store.ts`, `src/catalog.ts`, `src/transport.ts`, tests for these: connection/backend agent.
- `src/adapter.ts`, optional protocol helpers and tests: adapter agent.
- `src/index.ts`, `src/rpc.ts`, `src/client/*`, package/build/docs: parent.

## Service API

`MagpieService` is constructed with `{ storePath: string, fetch?: typeof fetch, onCatalogChanged?: () => void }`.

- `initialize(): Promise<void>` loads saved connection without throwing if no file. No background model requests unless saved connection exists. Read/parse failures must not overwrite file.
- `status(): StatusView` is synchronous, sanitized, secret-free.
- `connect(input: ConnectInput, signal?: AbortSignal): Promise<StatusView>` validates URL and login key, logs in, discovers gateway, creates a dedicated gateway key only with explicit `createGatewayKey: true` (UI checkbox), validates gateway/models, atomically persists, and publishes catalog. Use read-only bootstrap then enable key; clean up failures. No sharing changes. Supports optional explicit gatewayUrl/key for advanced fallback.
- `refresh(signal?: AbortSignal): Promise<StatusView>` coalesced directory refresh, keeps last successful catalog on failure, updates stale/error state.
- `disconnect(): Promise<StatusView>` removes local persisted connection and published routes, no deletion of user keys. UI explains gateway key remains and may be revoked in Magpie.
- `catalog(): readonly CatalogGroup[]` current last-good directory, each group has DSH provider route and upstream Magpie provider id.
- `capture(provider: string, model: string): CallTarget` immutable call generation with URL/key/model metadata, throws on missing route; used only on server, never RPC.
- `quotas(signal?: AbortSignal): Promise<QuotaView>` short cached management `/api/usage/quotas` or gateway kept quotas. Return compact sanitized summaries, no raw account data needed.
- `dispose(): void` stops background activity/aborts owned requests.

## Adapter API

`MagpieAdapter extends LlmAdapter`, constructed with service-like `{catalog():readonly CatalogGroup[], capture(provider:string,model:string):CallTarget}` plus optional attachment resolver `() => AttachmentStore | undefined` if needed. One adapter owns all group provider routes. listModels returns discovery metadata; resolveModel returns context/reasoning; prepareCall pins one CallTarget generation. Forward full Magpie model id verbatim, no X-Magpie-Account. Cancel promptly and attribution headers on every model request. Prefer reusing host-supported protocol library; no dependency on subscriptions plugin.

## Shared shapes

Defined in src/contracts.ts. Public views never contain loginKey, gatewayKey, cookies or signed-in URLs. Backend controls redact errors. Browser iframe login: user may authenticate directly; do NOT place long-lived key in iframe URL. No proxy/CSP rewrite in this prototype.
