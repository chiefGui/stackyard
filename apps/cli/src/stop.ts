import { reportDiagnostics, type DiagnosticSink } from "@stackyard/diagnostics";
import { discoverProject } from "@stackyard/project-loader";

import { defineCliCommand, type CliCommand } from "./cli.ts";
import type { ProjectClient } from "./project-client.ts";
import { normalizeProjectTarget } from "./project-target.ts";

export interface StopCommandDependencies {
  readonly client: ProjectClient;
  readonly currentDirectory: string;
  readonly diagnostics: DiagnosticSink;
  writeOutput(output: string): void;
}

export function createStopCommand(dependencies: StopCommandDependencies): CliCommand {
  return defineCliCommand("stop", "SYD2020", {
    args: {
      project: {
        description: "Project name, identifier, or directory",
        required: false,
        type: "positional",
      },
    },
    meta: { description: "Stop a project" },
    async run({ args }) {
      let target = args.project;
      if (!target) {
        const discovered = await discoverProject(undefined, dependencies.currentDirectory);
        if (!discovered.success) {
          reportDiagnostics(dependencies.diagnostics, discovered.diagnostics);
          return 1;
        }
        target = discovered.output.root;
      }
      const stopped = await dependencies.client.stop(
        await normalizeProjectTarget(target, dependencies.currentDirectory),
      );
      if (!stopped.success) {
        reportDiagnostics(dependencies.diagnostics, stopped.diagnostics);
        return 1;
      }
      dependencies.writeOutput(`Project '${stopped.output.name}' is stopped.\n`);
      return 0;
    },
  });
}
