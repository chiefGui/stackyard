# Stackyard

Stackyard is a machine-global local development control plane. This repository is currently at
Milestone 1: the workspace and architectural boundaries exist, but product behavior does not.

## Workspace

```text
apps/
  cli/              @stackyard/cli
  server/           @stackyard/server
  web/              @stackyard/web
packages/
  control-plane/    @stackyard/control-plane
  protocol/         @stackyard/protocol
  sdk/              @stackyard/sdk
examples/
  basic/            @stackyard/example-basic
```

Applications are executable surfaces. Packages are shared architectural boundaries. All workspace
dependencies are explicit and installed with Bun's isolated linker.

## Commands

```sh
bun install
bun run check
```

The complete check formats, lints, type-checks, tests, and builds every workspace.

## Dependency direction

```text
@stackyard/cli --------------------------> @stackyard/protocol
@stackyard/web --------------------------> @stackyard/protocol
@stackyard/server ---> @stackyard/control-plane ---> @stackyard/protocol
                  \----------------------> @stackyard/protocol
@stackyard/sdk --------------------------> @stackyard/protocol
```

The architecture test rejects undeclared internal dependency directions. Product behavior begins in
Milestone 2 with the definition pipeline.
