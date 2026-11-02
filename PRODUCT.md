# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

DSH users who already run Magpie and want provider-grouped models and access to its original management interface from DSH.

## Product Purpose

A lightweight independent connector: configure the Magpie management URL and login key once; discover models under Codex, WorkBuddy and other provider groups; leave all account selection, rotation and fallback to Magpie.

## Capabilities and Constraints

Do not modify Magpie or DSH core, do not ship Magpie frontend assets, and do not overwrite manually configured models. Use native DSH slots, settings and model adapter APIs. Open the original management page only after URL and key are configured; otherwise show friendly setup guidance. Use the existing desktop managed webview with one-time owner-RPC launch tickets and native POST login, never long-lived credentials in URLs. Do not silently downgrade to iframe or an external browser. No session expiry/relogin logic in this phase; unsupported clients get an explicit desktop requirement. Backend and model calls remain independent of the embedded page.

## Product Principles

- Thin integration over duplicated vendor logic.
- Credentials persist host-side; management login key may transit trusted renderer memory only for native POST, never URL, logs, public status or model context.
- Failures preserve last-known data rather than pretending it is empty.
- Upstream updates should not require vendored frontend patches.
- Inherit the existing DSH interface; user approved code-first implementation.
