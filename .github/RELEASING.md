# Releasing Stackyard

Stackyard uses Changesets to prepare versions and changelogs, then publishes the exact archive tested in GitHub Actions to npm with trusted publishing. No long-lived npm token belongs in GitHub.

## One-time setup

Complete the GitHub App, environment, and branch-protection setup before merging the release-automation pull request. Complete the npm bootstrap and trusted-publisher setup before merging the first version pull request.

### 1. Create the release GitHub App

Create a GitHub App, install it only on `chiefGui/stackyard`, and grant it these repository permissions:

- Contents: read and write
- Pull requests: read and write

Disable webhooks unless the app has another use. Generate a private key, then configure the repository with:

- Actions variable `RELEASE_APP_CLIENT_ID`: the app's client ID
- Actions secret `RELEASE_APP_PRIVATE_KEY`: the complete generated private key

The short-lived app token lets Changesets create a version pull request whose commits trigger normal CI. It is not used by the npm publishing job.

### 2. Protect the publishing environment

Create a GitHub Actions environment named `npm` and restrict its deployment branches to `main`. Add required reviewers only if another maintainer can reliably approve releases; do not create a single-maintainer deadlock.

### 3. Protect `main`

Create a repository ruleset for `main` that requires pull requests, resolved review conversations, and these CI checks:

- `Quality`
- `Tests (ubuntu-latest)`
- `Tests (windows-latest)`

Require branches to be up to date before merging, and block force pushes and branch deletion. Keep any emergency bypass narrow and auditable.

### 4. Bootstrap the npm package

npm only allows a trusted publisher to be configured after the package exists. After this pull request is merged, publish `0.0.0` once from a maintainer workstation using an npm account protected by two-factor authentication. Keep it off the `latest` tag:

```powershell
bun ci
New-Item -ItemType Directory -Force artifacts/bootstrap
npm pack ./apps/cli --pack-destination artifacts/bootstrap
bun scripts/verify-release-artifact.ts artifacts/bootstrap
npm publish artifacts/bootstrap/stackyard-0.0.0.tgz --access public --tag bootstrap
```

This bootstrap release exists only to establish package ownership. The initial Changeset prepares `0.1.0` as the first `latest` release.

### 5. Enable npm trusted publishing

In the `stackyard` package settings on npm, add a GitHub Actions trusted publisher with:

- Organization or user: `chiefGui`
- Repository: `stackyard`
- Workflow filename: `publish.yml`
- Environment: `npm`

Then require two-factor authentication and disallow granular access tokens for publishing. Do not create an `NPM_TOKEN` secret.

## Normal release flow

1. Add a Changeset to each pull request that changes published behavior with `bun run changeset`.
2. Merge the pull request after CI passes. Changesets creates or updates `chore: release Stackyard`.
3. Review the version, generated changelog, and lockfile in that pull request.
4. Merge the version pull request. The publish workflow packs the npm archive, runs the external-consumer test against that exact archive, publishes it with provenance, creates `stackyard@<version>`, and creates the matching GitHub release.

The version pull request is the release gate. Leave it open while accumulating changes and merge it only when that release should become public.

## Recovery

- If versioning, packing, verification, or npm publishing fails before npm accepts the version, fix the cause and rerun the failed workflow.
- If npm accepted the version but GitHub release creation failed, verify that `stackyard@<version>` points to the version pull request merge commit. Create only the missing GitHub release from that version's section in `apps/cli/CHANGELOG.md`; never republish or move an existing npm version.
- npm versions are immutable. Correct a bad release with a new patch and deprecate the bad version when appropriate; do not unpublish a version that users may have installed.

The workflow can also be run manually from GitHub Actions. It derives the safe next action from the repository and npm registry state; it does not accept an arbitrary version.
