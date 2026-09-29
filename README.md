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
runner's isolated server tree (`.bds/server/<version>/` by default). The world's
`world_behavior_packs.json` and `world_resource_packs.json` select the active stack using the source
manifests' header UUIDs and versions. Both development folders are refreshed on every run, and
world-local pack copies are removed so they cannot shadow the selected builds. The source packs,
server download cache, and Minecraft client/user directories are untouched.

Server development folders make the current build available to BDS. They do not guarantee that a
connecting client discards a cached resource pack with the same UUID and version; client-facing
iteration must separately verify which resource build is rendered.

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
