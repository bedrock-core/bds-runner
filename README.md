# @bedrock-core/bds-runner

Runs a Minecraft Bedrock addon's GameTests on a real Bedrock Dedicated Server, headless, and exits
with a CI status code. It downloads the server, boots it, activates your packs in a world, runs one
gametest tag, and reads each test's verdict from the server console.

```bash
npx @bedrock-core/bds-runner run --packs ./build --tag my-suite
```

```bash
yarn add --dev @bedrock-core/bds-runner
```

```
  packs: My Addon (behavior, my-addon_bp), My Addon Resources (resource, my-addon_rp)
  running my-suite

  ✗ my-suite:shop_opens
      expected block minecraft:chest at 2,1,2
      [Scripting][info] shop: no chest registered for plot 0

✗ 5 passed, 1 failed   (my-suite, BDS 1.26.45.1, 7.1s)
```

Pass `--keep-alive` and the server stays up after the results so you can join it yourself over
NetherNet and look at the plots; `stop` or Ctrl+C ends it.

Packs are copied into `development_behavior_packs/` and `development_resource_packs/` inside the
runner's isolated server tree (`.bds/server/<version>/` by default). Both development folders are
refreshed on every run, and world-local pack copies are removed so they cannot shadow the selected
builds. The source packs, server download cache, and Minecraft client/user directories are untouched.

Resource packs receive a deterministic deployment version derived from the completed copies of the
whole resource stack. File paths and bytes contribute to the SHA-256 fingerprint; source locations,
timestamps, and behavior-only edits do not. The same resource build keeps the same version, while a
resource edit, addition, or deletion changes the versions of every RP in the stack. This gives the
client a new UUID/version cache key without installing packs into its development folders. Minecraft
can still manage its own downloaded-pack cache when joining the server.

Header UUIDs stay unchanged. The runner rewrites resource header/module versions, UUID dependencies
in copied manifests, and world resource references consistently. Numeric-array and string version
representations are preserved. Behavior pack versions and Script API dependency versions stay as
authored. A dependency whose source version disagrees with the selected pack is rejected rather
than hidden by rewriting. Only copied manifests are made writable when a build exports read-only
files.

`pack-deployment.json` in the isolated server directory records the complete resource-stack digest,
individual resource hashes, source/deployed versions, and deployed paths. Three 16-bit components
encode the deployment version; the full digest history detects known collisions and fails instead
of reusing an ambiguous version. History is retained with that server tree. Pack directories and
the record must not be links, and pack sources must not overlap the managed destinations.

It also runs the server's pack optimizer, which packs a built addon's loose files into the archives
the game ships its own packs in. Converted packs need a 1.26.40 or newer client.

```bash
npx @bedrock-core/bds-runner optimize --packs ./build --out ./dist
```

`fetch` downloads and caches the server on its own, and `where` prints the resolved server
directory and version without running anything:

```bash
npx @bedrock-core/bds-runner fetch
npx @bedrock-core/bds-runner where
```

Commands, options, configuration and exit codes: https://bedrock-core.drav.dev/docs/bds-runner

## License

MIT
