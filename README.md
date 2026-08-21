# @bedrock-core/bds-runner

Runs Minecraft GameTests headlessly on a real **Bedrock Dedicated Server** and turns the result into
a CI exit code.

```bash
yarn test:mc
```

```
  packs: Economy (behavior, test-addon_bp), Economy resources (resource, test-addon_rp),
         Shop (behavior, test-addon-2_bp), Shop resources (resource, test-addon-2_rp)
  running core

  ✗ core:cross_pack_shop_present
      shop addon not present — is test-addon-2 installed and enabled?
      …the console lines leading up to it…

✓ 5 passed, 1 failed   (core, BDS 1.26.43.1, 7.1s)
```

## Why a real server

The tests exercise the actual engine — redstone, physics, block placement — so the only honest way
to run them is the actual engine. BDS is Minecraft without a client, it officially supports
`@minecraft/server-gametest`, and it runs on Windows and Linux, so the same path works locally and
in CI.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | every test passed, or the only failures were declared with `--known-failure` |
| `1` | tests failed |
| `2` | the run could not be trusted — no server, no boot, nothing announced, unknown tag |

`1` and `2` are deliberately distinct: a broken harness must not be able to masquerade as broken
code.

## Commands

```
bc-bds run --packs <dir> [--packs <dir> …] --tag <tag> [options]
bc-bds fetch      # download and cache the pinned server
bc-bds where      # resolved paths, plus the current upstream builds
```

`--packs` is repeatable, and that is how a **cross-addon** test runs: a test asserting that some
*other* pack is registered can only pass when both builds are in the same world, so each addon's
`build-test` export is named and they are deployed side by side.

Useful options: `--expect-registered <n>` (fail if the engine announces a different count),
`--known-failure <id>` (repeatable), `--idle <seconds>`, `--timeout <seconds>`, `--fresh`,
`--offline`, `--json <path>`.

## What it runs on

The runner deploys a build; it does not make one. The packs come from each addon's `build-test`
Regolith profile, which is the *only* shape that carries test code:

| | ships | `build-test` |
| --- | --- | --- |
| manifest | `manifest.json` | `manifest.test.json` — `extends` it, adds `@minecraft/server-gametest` |
| entry | `scripts/main.ts` | `scripts/gametest.ts` — imports `./main` and `./tests` |
| tsconfig | `tsconfig.json` | `tsconfig.test.json` |

`main.ts` must never import `./tests`. That single rule is what keeps a beta module and a test suite
out of a release: a filter that never ran, or ran wrong, yields a broken *test* build rather than a
release with gametests in it.

## How a run works

1. **Resolve a server** — `BC_BDS_PATH`, else the cache, else download the pinned build.
2. **Provision** `<repo>/.bds/server/<version>/` by copying the cache, and write `server.properties`.
3. **Bootstrap the world, once per version** — boot, stop, enable Beta APIs in `level.dat`, reboot.
4. **Deploy** the built packs into the world and write `world_behavior_packs.json` /
   `world_resource_packs.json` from each manifest's *header* uuid. Every Regolith export is called
   `BP/`, so each pack is copied under a folder named for the addon it came from — otherwise a
   second addon would silently overwrite the first.
5. **Run** — preload a ticking area, then
   `execute in overworld positioned <origin> run gametest runset <tag>`.
6. **Reconcile** the engine's output into one verdict per test, and exit accordingly.

## Things that are not obvious

**Beta APIs can only be enabled in NBT.** There is no `server.properties` key and no CLI flag for
experiments — they live in the world's `level.dat`, as a root `experiments` compound with a byte
called `gametest`. `@minecraft/server-gametest` is a beta module, so without it the `/gametest`
command does not exist. The runner boots once to let BDS generate the world, writes the toggle, and
reboots. It then checks the server's own boot log for `Experiment(s) active: gtst` rather than
trusting the write, because a silently failed write surfaces much later as `Unknown command:
gametest`, which reads like an entirely different problem.

**A playerless world does not tick.** Chunk simulation is bounded by `tick-distance` *from a
player*, and there is no player. Without `tickingarea add … true` every test that waits for
something to move sits still and times out. This was the single biggest risk in the design and it is
handled in one line.

**The 10-second Watchdog is a config key here.** `script-watchdog-hang-threshold` in
`server.properties` is the in-game hang detector that made heavy suites unrunnable in the client.
The runner raises it to 60 s, so suites that used to be skipped headless-only can simply run.

**Never shell-redirect the server's output.** Output is consumed through a pipe. With a redirect
nothing can react to a line as it arrives, so waiting for `Server started.` or for a run to go quiet
becomes impossible and a hung server is only discoverable by wall clock. (The previous harness
learned the same lesson from the other direction: Vitest workers write to the process's original
stdio handles, so `>` silently captured nothing.)

**The console is append-only across runs.** Issue two `runset`s in one session and both sets of
results sit in the same stream. The parser anchors on the *last* run announcement and discards
everything before it — otherwise a renamed or deleted test haunts the results forever.

**Verdicts come from the engine's own output.** It prints `Running N tests with tag '…'`, then
`onTestStructureLoaded:`, `onTestPassed:` and `onTestFailed: <id> - <error>` per test. Mojang
documents none of these strings, which sounds fragile but is not, because of two properties:

- the expected count and the verdicts come from the *same* channel, so a format change breaks both
  at once rather than one of them;
- **anything announced but unaccounted for is a failure**, never a pass.

So an engine that renames these lines produces a loud `0 of N accounted` infrastructure error. The
failure mode is a red build, never a false green — the only property that matters when you are
reading a private interface. There is deliberately no attempt to detect "the run finished" from a
string: the engine prints nothing at the end, so the run is over when every announced test has a
verdict, with idle and wall-clock timeouts behind that.

## Configuration

| Variable | Effect |
| --- | --- |
| `BC_BDS_PATH` | use a server you manage; skips download and version pinning entirely |
| `BC_BDS_HOME` | where the cache, server trees and logs live (default `<repo>/.bds`) |
| `BC_BDS_VERSION` | run against a different build than the pinned one, for a one-off check |

The pinned build lives in `bds-version.json`. It tracks the engine encoded in
`@minecraft/server-gametest`'s beta dist-tag (`1.0.0-beta.1.26.43-stable` → BDS `1.26.43.x`), so the
server and the type definitions describe the same engine.

### Where version data comes from

Mojang publishes no version index — only "here is the current build" — so build metadata comes from
[Bedrock-OSS/BDS-Versions](https://github.com/Bedrock-OSS/BDS-Versions), a community index that
records every build with its `sha1`, size and date. The runner reads the download URL and the
expected checksum from there, which buys three things:

- **integrity from the first byte.** The checksum is published by a third party, so a corrupted
  download — or Mojang re-rolling a build under the same version number — is caught on the first
  fetch rather than on a later one that disagrees with whatever arrived first.
- **a pin that can be validated.** `bc-bds where` reports the current stable and preview builds and
  warns if the pinned version is not in the index at all.
- **a comprehensible failure.** A typo'd version fails as "not in BDS-Versions, current stable is
  1.26.43.1" instead of a bare 404 from a different host.

> **It does not host the binaries.** Its `cdn_root` is minecraft.net and every `download_url` points
> there, so this does not help on a network that blocks that host — and some do block it (it
> resolves but never connects). There, prime the cache by hand or set `BC_BDS_PATH`; `--offline`
> makes the runner fail fast rather than hang on a download that cannot succeed. The download path
> is then exercised only in CI. Downloads also require a non-default `User-Agent`, since Mojang
> answers 403 otherwise.

## Layout

Everything the runner writes is under one gitignored directory, so it can all be reclaimed by
deleting `<repo>/.bds`:

```
.bds/
  cache/<version>/<platform>/   pristine extracted server, never run from
  server/<version>/             the tree BDS runs in; world bootstrapped once
  logs/<timestamp>-<tag>.log    full console transcript per run
```

The server tree is kept between runs — copying ~200 MB every time would dominate the runtime, and
symlinks need elevation on Windows. The world's `db/` *is* wiped each run, so every run starts from
untouched terrain while keeping the `level.dat` that took a boot cycle to prepare.
