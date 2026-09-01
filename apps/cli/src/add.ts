import { resolve } from "node:path";

import { reportDiagnostics, type DiagnosticSink } from "@stackyard/diagnostics";

import { defineCliCommand, type CliCommand } from "./cli.ts";
import type { RegistrationClient } from "./registration-client.ts";
import { registeredProjectLabel } from "./registration-output.ts";

export interface AddCommandDependencies {
  readonly client: RegistrationClient;
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
    meta: { description: "Register a project with Stackyard" },
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
  dependencies.writeOutput(
    `Registered '${registeredProjectLabel(project)}' with Stackyard.\nRoot: ${project.root}\n`,
  );
  if (project.definition.kind === "invalid" || project.definition.kind === "missing") {
    dependencies.writeOutput(
      `The project remains registered, but its definition is ${project.definition.kind}.\n`,
    );
    reportDiagnostics(dependencies.diagnostics, project.definition.diagnostics);
    return 1;
  }
  return 0;
}
