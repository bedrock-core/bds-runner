---
"@bedrock-core/bds-runner": minor
---

GameTests run headlessly on a real Bedrock Dedicated Server, and CI gets an exit code.

A GameTest is only meaningful on the engine that will run it, and the only engine there is runs as
a server. `bc-bds run` fetches the pinned build, lays the project's packs into a world, enables the
beta APIs the suites need, starts the server, runs a tagged set, reads the verdicts back off the
console and exits with a code CI can branch on.

```sh
bc-bds fetch
bc-bds run --packs build/main --packs build/peer --tag core --expect-registered 18
```

`--expect-registered` is the guard that makes a green run mean something: a suite that never
registered cannot fail, so the run is only a pass when the count the project expects actually
registered. Failure kinds are distinguished on the way out — a failing test, a suite that never
appeared, and the server never coming up are different exit codes, because only one of them is the
code's fault.

The server is managed rather than scripted at: `BdsServer` owns the process and its console,
`discoverPacks` reads what a build produced, `renderServerProperties` writes the properties the run
needs while leaving the rest alone, and `parseReport` / `summarise` / `formatSummary` turn console
lines into a verdict per test. Each is exported, so a project that wants a different harness can
build one from the same parts.

`bc-bds fetch` and `bc-bds where` are the cache: a build is downloaded once per version, keyed by
platform, and reused by every later run.
