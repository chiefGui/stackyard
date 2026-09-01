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
stackyard remove <project-name-or-id>
```

`stackyard add` registers the current project by finding its `stackyard/main.ts`. Pass another
directory to register it from anywhere. Registration evaluates the definition but does not start
its services.

Registered definitions are re-evaluated when files under their `stackyard/` directory change, and
they are loaded again whenever the machine-global daemon starts. `stackyard status` shows the
current definition state for every registered project.

`stackyard remove` only forgets the project registration. It never changes or deletes project
files, and it refuses to remove a project while that project is running.

See the [repository](https://github.com/chiefGui/stackyard) for documentation, examples, and issue tracking.

## License

Apache-2.0
