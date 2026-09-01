# Stackyard

Stackyard is a machine-global control plane for local development projects. It discovers project definitions, manages their processes, and exposes a single local dashboard.

> Stackyard is in early development. Its public API and configuration format may change before 1.0.

## Requirements

- [Bun](https://bun.sh/) 1.4 or newer

## Install

```sh
bun add --global stackyard
```

The package can also be installed with npm, but Stackyard still requires the Bun runtime:

```sh
npm install --global stackyard
```

## Usage

```sh
stackyard --version
stackyard help
stackyard add .
stackyard status
stackyard run .
stackyard remove <project-name-or-id>
```

`stackyard add` adds the current project by finding its `stackyard/main.ts`. Pass another directory
to add it from anywhere. Adding a project evaluates its definition but does not start its services.

Project definitions are re-evaluated when files under their `stackyard/` directory change, and they
are loaded again whenever the machine-global daemon starts. The dashboard and `stackyard status`
show every project, including projects whose services are stopped or whose definitions need
attention.

`stackyard run` starts the services from Stackyard's current project definition. Add a project
before running it. `stackyard remove` forgets the project without changing or deleting project
files, and it refuses to remove a project while that project is running.

See the [repository](https://github.com/chiefGui/stackyard) for documentation, examples, and issue tracking.

## License

Apache-2.0
