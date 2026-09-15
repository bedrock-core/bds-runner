---
"@bedrock-core/bds-runner": minor
---

Packs are optimized by the server's own converter, on the build the packs ask for.

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
