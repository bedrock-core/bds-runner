---
"@bedrock-core/bds-runner": patch
---

Capture native CPU profiles and diagnostics during GameTests, support Minecraft debugger attachment before tests, and expose per-run server properties and instrumentation hooks.

Await asynchronous result handlers while the server remains alive so debugger captures can finish before teardown.
