# Minecraft compatibility checks

`targets.json` pins the BDS build and npm SDK packages for each game release.
The matrix selects two stable drops and one Preview drop within `major`, starting
at `minimumDrop`. Hotfixes belong to their enclosing drop: `1.26.61.1` belongs to
26.60. Only the newest listed hotfix per drop is tested. Preview selection is
independent of stable selection.

Each game lists its stable API baseline and any supported RC or Beta API tracks.
The matrix also includes the project's unchanged lockfile. Updating the catalog
changes the supported targets; adding a newer stable drop evicts the oldest one.

`Update Minecraft compatibility targets` checks Tuesday/Wednesday at 17:19 and
21:19 UTC, Thursday/Friday at 22:19 UTC, and Wednesday–Saturday at 08:19 UTC for
catch-up. Manual invocation is also available.
It reads the BDS build index, Mojang's version-tagged Script
API module metadata, and the official Minecraft npm registry metadata. A target
requires BDS builds for Linux and Windows, matching Vanilla Data and GameTest
packages, and complete stable/RC/Beta API pairs exposed by that tagged game.
Stable hotfixes retain their enclosing drop's SDK snapshot; Preview requires its
exact tagged build. API versions come from Mojang's module metadata, independently
of the game version and without inferring versions from the Beta API number.

Complete updates create or refresh one pull request that changes only
`compatibility/targets.json`. Missing releases or packages appear in the workflow
summary and pull request body; existing pins remain until a complete replacement
is available. Failed metadata requests leave the catalog unchanged. The support
major, minimum drop and drop counts remain explicit policy in the catalog.

Merge the pull request to activate its pins. The workflow uses `GITHUB_TOKEN`,
which requires the repository setting **Allow GitHub Actions to create and approve
pull requests**. Pull requests created with that token do not trigger other
push/pull-request workflows; the updater runs catalog tests and matrix validation
before proposing changes. Consumers pick up merged targets on their next run.

Preview updates locally, or add `--write` to update the file:

```sh
node scripts/update-compatibility-targets.mjs
node --test scripts/update-compatibility-targets.test.mjs
```

The reusable workflow is
`bedrock-core/bds-runner/.github/workflows/minecraft-compatibility.yml@main`.
It accepts a `project` input:

| Project | Build and types | Unit tests | Native coverage |
| --- | --- | --- | --- |
| `server` | `build:libs` | `test` | Existing `test:mc` fixtures |
| `ui` | `build:libs` | `test:libs` | No native suite |
| `apps` | `typecheck`, `build` | `test` | Existing `test:mc` fixtures |

Each target uses a separate job. Preparation rewrites SDK resolutions and fixture
manifest dependencies in that job's disposable checkout. Pack UUIDs, versions,
script entrypoints and exports are retained. Stable and RC npm packages map to
their three-part native module version; Beta packages map to `x.y.z-beta`.
GameTest itself uses the Beta APIs experiment even in stable API rows.

Projects with sibling `file:` resolutions or TypeScript source aliases receive
the corresponding `server` and `ui` checkouts beside them. Those source peers
install with the same SDK selection. Registry-only projects need no peer checkout.

The optional `builder-ref` workflow input selects a Builder source checkout for
native fixtures. Server and Apps read it from the `COMPATIBILITY_BUILDER_REF`
repository or organization variable; an empty value uses their published Builder.
For local checkouts, `COMPATIBILITY_BUILDER_PATH=../builder` selects the adjacent
Builder CLI during preparation. Fixture build commands use that CLI; the project's
dependency lockfile retains its Builder dependency.

Native runs use the checked-out BDS Runner, an explicit version and game channel,
and a fresh test world. Their JSON evidence must identify the requested build,
contain test verdicts, and report no regressions, script errors or infrastructure
errors. Build checks, unit tests and native checks run independently after
installation. Every job uploads its target, outcomes and server logs; client
checks remain manual. The locked baseline runs build and unit checks only.

Under `act`, artifact upload is skipped because its artifact server does not
support `upload-artifact@v7`. Local target and native results remain in
`.bds/compatibility/`; GitHub runs upload them normally.

Inspect the matrix locally with:

```sh
node scripts/minecraft-compatibility.mjs matrix
node --test scripts/minecraft-compatibility.test.mjs
```

Publish the reusable workflow and its catalog to `bds-runner/main` before enabling
consumer workflows. Consumers run on pushes, pull requests, manual invocation,
and `repository_dispatch` events of type `minecraft-compatibility`.
