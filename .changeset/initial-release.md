---
"@bedrock-core/bds-runner": minor
---

First release as a standalone package.

Runs a Minecraft Bedrock addon's GameTests on a real Bedrock Dedicated Server, headless, and exits with a CI status code. No Minecraft client and no manual server download.

**Running tests.** `bc-bds run --packs <dir> --tag <tag>` deploys the packs into a world, runs one gametest tag and reports one verdict per test. `--packs` is repeatable, so a test that asserts another addon is installed can pass. Exit code `1` means tests failed and `2` means the run could not be trusted, so a broken harness never looks like broken code. A test the engine announces but never reports on counts as a failure, never a pass.

**Getting a server.** The build is downloaded and cached automatically, verified against the SHA-1 published by [Bedrock-OSS/BDS-Versions](https://github.com/Bedrock-OSS/BDS-Versions). Downloads have connect and stall timeouts, retry on transport errors, and report progress. `BC_BDS_PATH` uses a server you already have.

**Choosing the build.** Defaults to the newest stable build; no version is baked into the package. Select one with `--bds-version` / `--bds-channel`, `BC_BDS_VERSION` / `BC_BDS_CHANNEL`, or a committed `bds-runner.json`. Stable and preview are tracked separately. If the version index is unreachable the run fails rather than silently using a build nobody chose.

**Configuring the server.** A `properties` object in `bds-runner.json` is written into `server.properties` before every run. The runner generates a JSON Schema from the selected build's own `server.properties` at `.bds/schema/bds-runner.json`, so `$schema` gives editor completion, documentation and type checking for the exact build in use. The five keys the runner depends on are rejected with a message naming what controls them.

**Inspecting a failure.** `--keep-alive` keeps the server up after the results so you can join with a client and look at the test plots as the tests left them. The terminal is wired to the server console; `stop` or Ctrl+C ends the session and wipes the world.

Works with npm, Yarn and pnpm, including `npx @bedrock-core/bds-runner`. Windows and Linux, Node 20+.
