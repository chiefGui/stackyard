# Changesets

Every pull request that changes Stackyard's published behavior should include a changeset:

```sh
bun run changeset
```

Choose `patch` for compatible fixes, `minor` for compatible features, and `major` for breaking changes. Before 1.0, Changesets treats a `minor` bump as the breaking-change signal for a package already on `0.x`.

Write the summary for Stackyard's users. Explain what changed and why it matters; do not restate implementation details or the pull request title.

Pull requests that do not affect the published package can add an empty changeset with `bun run changeset --empty`, or explain in the pull request why no changeset is required.
