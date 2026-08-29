import { success, type Result } from "@stackyard/diagnostics";
import type { ProjectSpec } from "@stackyard/protocol";

import { discoverProject, type ProjectLocation } from "./discovery.ts";
import { evaluateProject } from "./evaluation.ts";
import { emptyCapturedProcessOutput, type CapturedProcessOutput } from "./process-output.ts";

export interface LoadProjectOptions {
  readonly currentDirectory: string;
  readonly evaluatorEntrypoint: string;
  readonly path?: string;
}

export interface LoadedProject {
  readonly location: ProjectLocation;
  readonly spec: ProjectSpec;
}

export interface ProjectLoadOutcome {
  readonly result: Result<LoadedProject>;
  readonly stderr: CapturedProcessOutput;
  readonly stdout: CapturedProcessOutput;
}

export async function loadProject(options: LoadProjectOptions): Promise<ProjectLoadOutcome> {
  const location = await discoverProject(options.path, options.currentDirectory);

  if (!location.success) {
    return {
      result: location,
      stderr: emptyCapturedProcessOutput(),
      stdout: emptyCapturedProcessOutput(),
    };
  }

  const evaluation = await evaluateProject(
    options.evaluatorEntrypoint,
    location.output.entrypoint,
    location.output.root,
  );

  if (!evaluation.result.success) {
    return {
      result: evaluation.result,
      stderr: evaluation.stderr,
      stdout: evaluation.stdout,
    };
  }

  return {
    result: success({ location: location.output, spec: evaluation.result.output }),
    stderr: evaluation.stderr,
    stdout: evaluation.stdout,
  };
}
