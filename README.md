# Stackyard

A machine-global local development control plane. Early development.

## Development

Install the exact dependency graph with Bun 1.4.0:

```sh
bun ci
```

Run the complete local quality gate before opening a pull request:

```sh
bun run check
```

The individual gates are `format:check`, `lint`, `typecheck`, `test:coverage`, and `build`.
Use `bun run format` and `bun run lint:fix` to apply safe mechanical fixes, or `bun run test` and
`bun run test:watch` for faster feedback while developing.

CI runs static quality checks once on Linux and runs the test suite on both Linux and Windows.
The Linux test run enforces at least 90% line and function coverage and retains its LCOV report for
seven days.

## Performance

Tests protect correctness; benchmarks show how project parsing and compilation time changes as a
project grows.

Run the project-model microbenchmarks with:

```sh
bun run bench
```

Compare a base revision and a change on the same quiet machine. Shared CI runners are too noisy for
reliable timing thresholds, so benchmarks are intentionally measured rather than used as flaky
pass/fail gates. Add representative workloads when introducing a new hot path or changing its
complexity.
