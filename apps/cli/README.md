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
stackyard
stackyard daemon start
stackyard daemon start --foreground
stackyard daemon status
stackyard daemon stop
stackyard add .
stackyard list
stackyard run
stackyard stop
stackyard remove <project-name-or-id>
```

Run `stackyard` without a command to see help. `stackyard daemon start` starts the machine-global
daemon, safely reuses it when it is already running, and prints the dashboard URL. Use
`stackyard daemon start --foreground` when the daemon should stay attached to the terminal for
debugging. `stackyard daemon status` inspects it, while `stackyard daemon stop` gracefully stops it
and every project it manages. Repeated start and stop commands are safe.

`stackyard add` adds the current project by finding its `stackyard/main.ts`. Pass another directory
to add it from anywhere. Adding a project evaluates its definition but does not start its services.

Project definitions are re-evaluated when files under their `stackyard/` directory change, and they
are loaded again whenever the machine-global daemon starts. The dashboard and `stackyard list`
show every project, including projects whose services are stopped or whose definitions need
attention.

`stackyard run` starts a project, starts the daemon when needed, and stays attached until the
project stops. Pass a project directory to run another project, and add it to Stackyard before
running it. Services start with their project by default. Set `startWithProject: false` in a service
definition when `stackyard run` should leave it stopped.

`stackyard stop` stops the project containing the current directory. It also accepts a project
name, identifier, or directory. It neither starts nor stops the daemon. `stackyard remove` forgets
the project without changing or deleting project files, and it refuses to remove a running project.

See the [repository](https://github.com/chiefGui/stackyard) for documentation, examples, and issue tracking.

## License

Apache-2.0
