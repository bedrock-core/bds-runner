# @bedrock-core/bds-runner

## 0.1.0

### Minor Changes

- [`b93b2de`](https://github.com/bedrock-core/bds-runner/commit/b93b2dee974272adadf79094ead5447663a00144) Thanks [@drav0011](https://github.com/drav0011)! - GameTests run headlessly on a real Bedrock Dedicated Server, and CI gets an exit code.
  
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

- [`b93b2de`](https://github.com/bedrock-core/bds-runner/commit/b93b2dee974272adadf79094ead5447663a00144) Thanks [@drav0011](https://github.com/drav0011)! - Packs are optimized by the server's own converter, on the build the packs ask for.
  
  `bc-bds optimize` drives `bedrock_server PackOptimizerConfigPath=<config>`, which reads a directory
  whose subdirectories are each one pack — Regolith's `build/` is already that shape — minifies their
  JSON, packs each folder into a `.brarchive` under `__brarchive/`, and stamps
  `pack_optimization_version` into the manifest. `--unpack` runs it backwards, expanding the archives
  into loose files again. `optimizePacks` is the same thing as a function, returning what each pack
  weighed before and after.
  
  A `.brarchive` is a load-time format, not a compression one: it is an uncompressed per-directory
  container costing about 256 bytes an entry, and what it buys is the client opening one file instead
  of thousands.
  
  A converted pack needs a 1.26.40 or newer client, and the converter does not raise
  `min_engine_version` to say so — which is why the build is chosen from the packs rather than from a
  default. With no `bds-runner.json`, `detectPin` walks the project's manifests, takes the highest
  `min_engine_version` they agree on, and picks the newest build published in that line: `1.26.40`
  resolves to the newest `1.26.40.x`. Running the tests on exactly that build tests the promise the
  packs make to players, and converting on it cannot emit an archive format the promise does not
  allow.
  
  The choice is written out as `bds-runner.json` the moment it is made, so it stops being implicit
  and every later run is reproducible. A project that already has the config file is never detected
  for.

- [`51acb30`](https://github.com/bedrock-core/bds-runner/commit/51acb303a534bbf7e2ef7f6eb92ef3f1ee62ffab) Thanks [@drav0011](https://github.com/drav0011)! - First public release of the BDS GameTest runner. It downloads and provisions BDS, optimizes packs, runs tagged GameTests, and reports CI-ready results. It also rejects optimizer output paths that overlap source packs and cleans up only an incomplete generated world after a failed first boot.
