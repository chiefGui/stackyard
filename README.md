# Stackyard

A machine-global control plane for local development projects. Stackyard discovers project definitions, manages their processes, and exposes a single local dashboard.

> Stackyard is in early development. Its public API and configuration format may change before 1.0.

## Development

Stackyard requires [Bun](https://bun.sh/) 1.4 or newer.

```sh
bun ci
bun run check
```

Changes to published behavior should include a Changesets entry:

```sh
bun run changeset
```

## License

Stackyard is licensed under the [Apache License 2.0](./LICENSE).
