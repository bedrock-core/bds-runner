# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets).
It tracks pending version bumps and changelog entries for `@bedrock-core/bds-runner`.

## Authoring a changeset

When you make a change worth releasing, run:

```sh
yarn changeset
```

Pick a bump level (`patch` / `minor` / `major`), write a short summary, and commit the
generated `.changeset/<name>.md` alongside your change.

## How releasing works

Versioning is automatic; publishing is manual. The **Release** workflow
(`.github/workflows/publish.yml`) has two jobs:

- **On every push to `main`**, if changesets are pending, it opens (or refreshes) a
  **"Version Packages"** PR built by `yarn version-packages`, which consumes the pending
  changesets, bumps `package.json` and writes `CHANGELOG.md`. Nothing is published from a
  push.
- **When run by hand** (Actions → Release → Run workflow), it refuses if changesets are still
  pending, then executes `yarn release`: lint, typecheck and tests, then `changeset publish`,
  which pushes the package to npm, tags it `@bedrock-core/bds-runner@<version>`, and cuts a
  GitHub release.

So a release is: merge the Version PR, then trigger the workflow.

While `package.json` has `"private": true`, the Version PR still opens and merges, but
`changeset publish` skips the package. Remove that field when the package is ready to go on
npm.

Two repo settings the workflow depends on:

- *Allow GitHub Actions to create and approve pull requests* (Settings → Actions → General).
  Without it the Version PR cannot be opened.
- A trusted publisher on npmjs.com for `@bedrock-core/bds-runner` pointing at this repo and
  `publish.yml`. Publishing authenticates through OIDC; no npm token is stored anywhere.
