import { resolve } from "node:path";

import { reportDiagnostics, type DiagnosticSink } from "@stackyard/diagnostics";

import { defineCliCommand, type CliCommand } from "./cli.ts";
import type { ProjectClient } from "./project-client.ts";

export interface AddCommandDependencies {
  readonly client: ProjectClient;
  readonly diagnostics: DiagnosticSink;
  readonly currentDirectory: string;
  writeOutput(output: string): void;
}

export function createAddCommand(dependencies: AddCommandDependencies): CliCommand {
  return defineCliCommand("add", "SYD2013", {
    args: {
      path: {
        description: "Project directory (default: current directory)",
        required: false,
        type: "positional",
      },
    },
    meta: { description: "Add a project to Stackyard" },
    run({ args }) {
      return addProject(args.path, dependencies);
    },
  });
}

async function addProject(
  path: string | undefined,
  dependencies: AddCommandDependencies,
): Promise<number> {
  const added = await dependencies.client.add(resolve(dependencies.currentDirectory, path ?? "."));
  if (!added.success) {
    reportDiagnostics(dependencies.diagnostics, added.diagnostics);
    return 1;
  }

  const project = added.output;
  dependencies.writeOutput(`Added '${project.name}' to Stackyard.\nRoot: ${project.root}\n`);
  if (project.issue) {
    dependencies.writeOutput("The project needs attention before it can run.\n");
    reportDiagnostics(dependencies.diagnostics, project.issue.diagnostics);
    return 1;
  }
  return 0;
}
