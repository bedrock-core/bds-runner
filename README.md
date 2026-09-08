# @bedrock-core/bds-runner

Runs a Minecraft Bedrock addon's GameTests on a real Bedrock Dedicated Server, headless, and exits
with a CI status code. It downloads the server, boots it, installs your packs into a world, runs one
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

Commands, options, configuration and exit codes: https://bedrock-core.drav.dev/docs/bds-runner

## License

MIT
