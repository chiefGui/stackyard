import { reportDiagnostics, type DiagnosticSink } from "@stackyard/diagnostics";
import type { ProjectLoadOutcome } from "@stackyard/project-loader";

import { defineCliCommand, type CliCommand } from "./cli.ts";
import { writeProjectEvaluationOutput } from "./project-output.ts";

export interface InspectCommandDependencies {
  readonly diagnostics: DiagnosticSink;
  loadProject(path: string | undefined): Promise<ProjectLoadOutcome>;
  writeError(output: string): void;
  writeOutput(output: string): void;
}

export function createInspectCommand(dependencies: InspectCommandDependencies): CliCommand {
  return defineCliCommand(
    "inspect",
    {
      args: {
        path: {
          description: "Project directory",
          required: false,
          type: "positional",
        },
        json: {
          description: "Print compact JSON",
          type: "boolean",
        },
      },
      meta: {
        description: "Evaluate and print a project definition",
      },
      run({ args }) {
        return runInspect(args.path, args.json ?? false, dependencies);
      },
    },
    {
      code: "SYD2005",
      help: "Use: stackyard inspect [path] [--json]",
      tooManyPositionals: "Inspect accepts at most one project path.",
    },
  );
}

async function runInspect(
  path: string | undefined,
  json: boolean,
  dependencies: InspectCommandDependencies,
): Promise<number> {
  const project = await dependencies.loadProject(path);
  writeProjectEvaluationOutput(project, dependencies);

  if (!project.result.success) {
    reportDiagnostics(dependencies.diagnostics, project.result.diagnostics);
    return 1;
  }

  let indentation: number | undefined = 2;
  if (json) {
    indentation = undefined;
  }
  dependencies.writeOutput(
    `${JSON.stringify(project.result.output.spec, undefined, indentation)}\n`,
  );
  return 0;
}
