import {
  createDiagnostic,
  failure,
  isNonEmptyDiagnostics,
  success,
  type NonEmptyDiagnostics,
  type Result,
} from "@stackyard/diagnostics";

import { deepFreeze } from "./freeze.ts";
import { parseProjectSpec, type ProjectSpec } from "./project.ts";
import { protocolVersion } from "./version.ts";

export type RegisteredProjectDefinition =
  | {
      readonly kind: "invalid" | "missing";
      readonly diagnostics: NonEmptyDiagnostics;
      readonly lastValidSpec?: ProjectSpec;
    }
  | { readonly kind: "loading" }
  | { readonly kind: "valid"; readonly spec: ProjectSpec };

export interface RegisteredProject {
  readonly definition: RegisteredProjectDefinition;
  readonly id: string;
  readonly root: string;
}

export interface RegisteredProjectList {
  readonly projects: readonly RegisteredProject[];
  readonly schemaVersion: typeof protocolVersion;
}

export function createRegisteredProject(input: RegisteredProject): RegisteredProject {
  return deepFreeze({ ...input });
}

export function createRegisteredProjectList(
  projects: readonly RegisteredProject[],
): RegisteredProjectList {
  return deepFreeze({ projects: [...projects], schemaVersion: protocolVersion });
}

export function parseRegisteredProject(input: unknown): Result<RegisteredProject> {
  const project = readRegisteredProject(input);
  return project ? success(deepFreeze(project)) : invalidRegisteredProjects("Registered project");
}

export function parseRegisteredProjectList(input: unknown): Result<RegisteredProjectList> {
  if (
    !isPlainObject(input) ||
    !hasExactKeys(input, ["projects", "schemaVersion"]) ||
    input.schemaVersion !== protocolVersion ||
    !Array.isArray(input.projects)
  ) {
    return invalidRegisteredProjects("Registered project list");
  }

  const projects: RegisteredProject[] = [];
  const identifiers = new Set<string>();
  const roots = new Set<string>();
  for (const inputProject of input.projects) {
    const project = readRegisteredProject(inputProject);
    if (!project || identifiers.has(project.id) || roots.has(project.root)) {
      return invalidRegisteredProjects("Registered project list");
    }
    identifiers.add(project.id);
    roots.add(project.root);
    projects.push(project);
  }

  return success(deepFreeze({ projects, schemaVersion: protocolVersion }));
}

function readRegisteredProject(input: unknown): RegisteredProject | undefined {
  if (
    !isPlainObject(input) ||
    !hasExactKeys(input, ["definition", "id", "root"]) ||
    !isNonEmptyString(input.id) ||
    !isNonEmptyString(input.root) ||
    !isAbsolutePath(input.root)
  ) {
    return undefined;
  }

  const definition = readDefinition(input.definition);
  return definition ? { definition, id: input.id, root: input.root } : undefined;
}

function readDefinition(input: unknown): RegisteredProjectDefinition | undefined {
  if (!isPlainObject(input) || !isNonEmptyString(input.kind)) {
    return undefined;
  }
  if (input.kind === "loading") {
    return hasExactKeys(input, ["kind"]) ? { kind: "loading" } : undefined;
  }
  if (input.kind === "valid") {
    if (!hasExactKeys(input, ["kind", "spec"])) {
      return undefined;
    }
    const spec = parseProjectSpec(input.spec);
    return spec.success ? { kind: "valid", spec: spec.output } : undefined;
  }
  if (input.kind !== "invalid" && input.kind !== "missing") {
    return undefined;
  }
  if (
    !hasExactKeys(input, ["diagnostics", "kind"], ["lastValidSpec"]) ||
    !isNonEmptyDiagnostics(input.diagnostics)
  ) {
    return undefined;
  }

  let lastValidSpec: ProjectSpec | undefined;
  if (input.lastValidSpec !== undefined) {
    const parsed = parseProjectSpec(input.lastValidSpec);
    if (!parsed.success) {
      return undefined;
    }
    lastValidSpec = parsed.output;
  }

  return {
    diagnostics: input.diagnostics,
    kind: input.kind,
    ...(lastValidSpec ? { lastValidSpec } : {}),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function invalidRegisteredProjects(subject: string): Result<never> {
  return failure(
    createDiagnostic({
      code: "SYD1201",
      help: "Update Stackyard so the CLI and daemon use the same protocol, then retry.",
      message: `${subject} is invalid.`,
    }),
  );
}
