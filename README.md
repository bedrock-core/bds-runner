# @bedrock-core/bds-runner

Runs a Minecraft Bedrock addon's GameTests on a real Bedrock Dedicated Server, headless, and exits
with a CI status code.

```bash
npx @bedrock-core/bds-runner run --packs ./build --tag my-suite
```

```
  packs: My Addon (behavior, my-addon_bp), My Addon Resources (resource, my-addon_rp)
  running my-suite

  ✗ my-suite:shop_opens
      expected block minecraft:chest at 2,1,2
      [Scripting][info] shop: no chest registered for plot 0

✗ 5 passed, 1 failed   (my-suite, BDS 1.26.45.1, 7.1s)
```

The runner downloads the server, boots it, installs your packs into a world, runs one gametest tag,
and reads each test's verdict from the server console. It needs no Minecraft client and no manual
server download.

## Requirements

- Node 20 or newer.
- Windows or Linux. Mojang publishes the dedicated server for those two platforms only.
- A behaviour pack whose manifest depends on `@minecraft/server-gametest` and whose scripts register
  tests under the tag you pass.

## Install

For one-off use, run it through your package manager without installing:

```bash
npx @bedrock-core/bds-runner run --packs ./build --tag my-suite
yarn dlx @bedrock-core/bds-runner run --packs ./build --tag my-suite
pnpm dlx @bedrock-core/bds-runner run --packs ./build --tag my-suite
```

To add it to a project:

```bash
yarn add --dev @bedrock-core/bds-runner
```

```json
{ "scripts": { "test:mc": "bc-bds run --packs ./build --tag my-suite" } }
```

## Commands

```
bc-bds run --packs <dir> --tag <tag> [options]   run a suite
bc-bds fetch                                     download and cache the server
bc-bds where                                     show which build will be used, and from where
```

### `run` options

| Option | Effect |
| --- | --- |
| `--packs <dir>` | A build directory. Repeatable. Required. |
| `--tag <tag>` | The gametest tag to run. Required. |
| `--expect-registered <n>` | Fail unless the engine announces exactly `n` tests. Catches a suite that silently failed to register. |
| `--known-failure <id>` | A test that is expected to fail. Repeatable. It is reported but does not make the run red. |
| `--origin "<x> <y> <z>"` | Where test plots are placed. Default `8 -60 8`. |
| `--idle <seconds>` | End the run once the server has been quiet this long with every test accounted for. Default 45. |
| `--timeout <seconds>` | Wall-clock limit for the whole run. Default 900. |
| `--port <n>` | Server port. Default 19140. |
| `--fresh` | Recreate the server tree and world from scratch. |
| `--keep-alive` | After the results, keep the server running so you can join it. See [Looking at the plots](#looking-at-the-plots). |
| `--offline` | Never download. Fail if the server is not already cached. |
| `--quiet` | Do not echo server output while the run is in progress. |
| `--json <path>` | Also write the result as JSON: tag, server version, duration, per-test verdicts, regressions, and any infrastructure error. |

### Build selection options

Accepted by every command. See [Choosing the server build](#choosing-the-server-build).

| Option | Effect |
| --- | --- |
| `--bds-version <v>` | An exact build such as `1.26.45.1`, or `latest`. |
| `--bds-channel <c>` | `stable` or `preview`. |
| `--config <path>` | Read this `bds-version.json` instead of searching for one. |

### What `--packs` accepts

Either a directory containing `BP/` and optionally `RP/`, which is what Regolith exports, or a
directory that is itself a single pack. A pack is treated as a behaviour pack when its manifest
declares a `script` or `data` module, and as a resource pack otherwise.

Passing `--packs` more than once installs several addons into the same world. That is how a test
which asserts that *another* addon is present can pass. Each pack is copied into the world under a
folder named after the addon it came from, so two addons that both export `BP/` do not collide.

## Looking at the plots

A failure message says what the assertion was, not what the world looked like. `--keep-alive`
keeps the server up after the results are printed so you can connect a client and see for
yourself:

```bash
bc-bds run --packs ./build --tag my-suite --keep-alive
```

```
✗ 5 passed, 1 failed   (my-suite, BDS 1.26.45.1, 7.1s)
  log: .bds/logs/2026-09-07T20-26-53-336Z-core.log

  server kept running for inspection: connect to 127.0.0.1:19140
  type a server command here; `stop` or Ctrl+C ends the session
```

The test structures are left exactly as the tests left them. The server is advertised on the local
network, so it shows up under Friends in the client; otherwise add it as a server at
`127.0.0.1` on the run's port. You join in creative mode as an operator.

While it is up, anything typed into the terminal is sent to the server console, so you can
teleport, run `gametest runset` again, or anything else. `stop` or Ctrl+C shuts the server down
cleanly, and the world is wiped once it has exited. The exit code is the one the tests earned,
regardless of what happened afterwards.

On Windows, the Minecraft app cannot connect to a server on the same machine until the app is
exempted from loopback isolation. This is a one-time step in an elevated prompt:

```
CheckNetIsolation LoopbackExempt -a -n=Microsoft.MinecraftUWP_8wekyb3d8bbwe
```

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Every test passed, or the only failures were declared with `--known-failure`. |
| `1` | Tests failed. |
| `2` | The run could not be trusted: no server, no boot, no tests announced, or the tag is unknown. |

`1` and `2` are distinct so that a broken harness can never look like broken code.

Any test the engine announces but never reports a verdict for is counted as a failure. The run
is over when every announced test has a verdict, or when the idle or wall-clock timeout fires.

## Choosing the server build

By default the runner uses the newest stable build.

To use a specific build for one run:

```bash
bc-bds run --packs ./build --tag my-suite --bds-version 1.26.45.1
bc-bds where --bds-channel preview
```

To commit the choice so every developer and every CI job use the same engine, add a
`bds-version.json` at or above the directory you run the command from, usually the project root:

```json
{ "version": "1.26.45.1", "channel": "stable" }
```

`version` is an exact build or `"latest"`. `channel` is `stable` or `preview`. Both keys are
optional.

Precedence, highest first:

1. `--bds-version` / `--bds-channel`
2. `BC_BDS_VERSION` / `BC_BDS_CHANNEL`
3. The nearest `bds-version.json`, or the file named by `--config`
4. Newest `stable`

`bc-bds where` prints the selected build, the config file it came from, and the current upstream
builds.

Build metadata comes from [Bedrock-OSS/BDS-Versions](https://github.com/Bedrock-OSS/BDS-Versions);
the download itself comes from minecraft.net and is checked against the published SHA-1. If the
index is unreachable the run fails rather than falling back to a build it already has.

## Environment variables

| Variable | Effect |
| --- | --- |
| `BC_BDS_PATH` | Use a server you already have. Point it at the directory containing `bedrock_server` or `bedrock_server.exe`. Skips download and build selection. |
| `BC_BDS_HOME` | Where the cache, server trees and logs are kept. Default `<project>/.bds`, which you should add to `.gitignore`. |
| `BC_BDS_VERSION` | Build to use. Accepts `latest`. |
| `BC_BDS_CHANNEL` | `stable` or `preview`. |

`BC_BDS_PATH` is the route for networks that cannot reach minecraft.net.

## License

MIT
