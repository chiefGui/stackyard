import type { DiagnosticSink, Failure } from "@stackyard/diagnostics";
import { discoverProject } from "@stackyard/project-loader";
import { Effect, Option } from "effect";
import { Argument } from "effect/unstable/cli";

import { defineCliCommand, reportCommandFailure, type CliCommand } from "./cli.ts";
import { ProjectClient } from "./project-client.ts";
import { normalizeProjectTarget } from "./project-target.ts";

export interface StopCommandDependencies {
  readonly currentDirectory: string;
  readonly diagnostics: DiagnosticSink;
  writeOutput(output: string): void;
}

export function createStopCommand(
  dependencies: StopCommandDependencies,
): CliCommand<ProjectClient> {
  return defineCliCommand("stop", "SYD2020", {
    args: {
      project: Argument.string("project").pipe(
        Argument.withDescription("Project name, identifier, or directory"),
        Argument.optional,
        Argument.map(Option.getOrUndefined),
      ),
    },
    meta: { description: "Stop a project" },
    positionalLimit: 1,
    run({ args }) {
      return reportCommandFailure(
        stopProject(args.project, dependencies),
        dependencies.diagnostics,
      );
    },
  });
}

const stopProject = Effect.fn("stopProject")(function* (
  project: string | undefined,
  dependencies: StopCommandDependencies,
): Effect.fn.Return<number, Failure, ProjectClient> {
  let target = project;
  if (!target) {
    const discovered = yield* discoverProject(undefined, dependencies.currentDirectory);
    target = discovered.root;
  }
  const client = yield* ProjectClient;
  const normalizedTarget = yield* normalizeProjectTarget(target, dependencies.currentDirectory);
  const stopped = yield* client.stop(normalizedTarget);
  dependencies.writeOutput(
    stopped.kind === "daemon-not-running"
      ? "No project is running because Stackyard is not running.\n"
      : `Project '${stopped.project.name}' is stopped.\n`,
  );
  return 0;
});
