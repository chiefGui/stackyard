import {
  createDiagnostic,
  failure,
  isDiagnosticReport,
  success,
  type DiagnosticReport,
  type Result,
} from "@stackyard/diagnostics";

import { deepFreeze } from "./freeze.ts";
import { isLoopbackHttpUrl } from "./loopback-url.ts";
import { protocolVersion } from "./version.ts";

export type ProjectState =
  | "loading"
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "needs-attention";

export type ServiceState = "stopped" | "starting" | "running" | "stopping" | "exited" | "failed";

export interface ServiceEndpoint {
  readonly name: string;
  readonly url: string;
}

export interface Service {
  readonly endpoints: readonly ServiceEndpoint[];
  readonly exitCode?: number | undefined;
  readonly name: string;
  readonly startWithProject: boolean;
  readonly state: ServiceState;
}

export interface Project {
  readonly id: string;
  readonly issue?: DiagnosticReport | undefined;
  readonly name: string;
  readonly restartRequired: boolean;
  readonly root: string;
  readonly services: readonly Service[];
  readonly state: ProjectState;
}

export interface ProjectList {
  readonly projects: readonly Project[];
  readonly schemaVersion: typeof protocolVersion;
}

export function createProject(input: Project): Project {
  return deepFreeze(input);
}

export function createProjectList(input: Omit<ProjectList, "schemaVersion">): ProjectList {
  return deepFreeze({ ...input, schemaVersion: protocolVersion });
}

export function parseProject(input: unknown): Result<Project> {
  const project = readProject(input);
  return project ? success(deepFreeze(project)) : invalidProjects("Project");
}

export function parseProjectList(input: unknown): Result<ProjectList> {
  if (
    !isPlainObject(input) ||
    !hasExactKeys(input, ["projects", "schemaVersion"]) ||
    input.schemaVersion !== protocolVersion ||
    !Array.isArray(input.projects)
  ) {
    return invalidProjects("Project list");
  }

  const projects: Project[] = [];
  const ids = new Set<string>();
  const roots = new Set<string>();
  for (const inputProject of input.projects) {
    const project = readProject(inputProject);
    if (!project || ids.has(project.id) || roots.has(project.root)) {
      return invalidProjects("Project list");
    }
    ids.add(project.id);
    roots.add(project.root);
    projects.push(project);
  }

  return success(deepFreeze({ projects, schemaVersion: protocolVersion }));
}

function readProject(input: unknown): Project | undefined {
  if (
    !isPlainObject(input) ||
    !hasExactKeys(
      input,
      ["id", "name", "restartRequired", "root", "services", "state"],
      ["issue"],
    ) ||
    !isNonEmptyString(input.id) ||
    !isNonEmptyString(input.name) ||
    typeof input.restartRequired !== "boolean" ||
    !isNonEmptyString(input.root) ||
    !isAbsolutePath(input.root) ||
    !Array.isArray(input.services) ||
    !isProjectState(input.state) ||
    (input.issue !== undefined && !isDiagnosticReport(input.issue))
  ) {
    return undefined;
  }

  const services: Service[] = [];
  const serviceNames = new Set<string>();
  for (const inputService of input.services) {
    const service = readService(inputService);
    if (!service || serviceNames.has(service.name)) {
      return undefined;
    }
    serviceNames.add(service.name);
    services.push(service);
  }

  return {
    id: input.id,
    ...(input.issue ? { issue: input.issue } : {}),
    name: input.name,
    restartRequired: input.restartRequired,
    root: input.root,
    services,
    state: input.state,
  };
}

function readService(input: unknown): Service | undefined {
  if (
    !isPlainObject(input) ||
    !hasExactKeys(input, ["endpoints", "name", "startWithProject", "state"], ["exitCode"]) ||
    !Array.isArray(input.endpoints) ||
    !isNonEmptyString(input.name) ||
    typeof input.startWithProject !== "boolean" ||
    !isServiceState(input.state) ||
    (input.exitCode !== undefined &&
      (typeof input.exitCode !== "number" || !Number.isSafeInteger(input.exitCode)))
  ) {
    return undefined;
  }

  const endpoints: ServiceEndpoint[] = [];
  const endpointNames = new Set<string>();
  for (const inputEndpoint of input.endpoints) {
    if (
      !isPlainObject(inputEndpoint) ||
      !hasExactKeys(inputEndpoint, ["name", "url"]) ||
      !isNonEmptyString(inputEndpoint.name) ||
      endpointNames.has(inputEndpoint.name) ||
      !isLoopbackHttpUrl(inputEndpoint.url)
    ) {
      return undefined;
    }
    endpointNames.add(inputEndpoint.name);
    endpoints.push({ name: inputEndpoint.name, url: inputEndpoint.url });
  }

  return {
    endpoints,
    ...(typeof input.exitCode === "number" ? { exitCode: input.exitCode } : {}),
    name: input.name,
    startWithProject: input.startWithProject,
    state: input.state,
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

function isProjectState(value: unknown): value is ProjectState {
  return (
    value === "loading" ||
    value === "stopped" ||
    value === "starting" ||
    value === "running" ||
    value === "stopping" ||
    value === "needs-attention"
  );
}

function isServiceState(value: unknown): value is ServiceState {
  return (
    value === "stopped" ||
    value === "starting" ||
    value === "running" ||
    value === "stopping" ||
    value === "exited" ||
    value === "failed"
  );
}

function invalidProjects(subject: string): Result<never> {
  return failure(
    createDiagnostic({
      code: "SYD1200",
      help: "Update Stackyard so the client and daemon use the same protocol, then retry.",
      message: `${subject} is invalid.`,
    }),
  );
}
