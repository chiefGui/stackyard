import {
  createDiagnostic,
  failure,
  success,
  type Failure,
  type Result,
  type Success,
} from "@stackyard/diagnostics";
import {
  environmentKey,
  type EndpointValueExpression,
  type ProcessResourceSpec,
  type ProjectSpec,
} from "@stackyard/protocol";

import { type ProjectList, type ServiceEndpoint, type ServiceState } from "./project-list.ts";

/* oxlint-disable eslint/no-await-in-loop -- Allocation and launch are deliberately ordered transactions. */

export interface PortLease {
  readonly host: string;
  readonly port: number;
  dispose(): Promise<Result<void>>;
  releaseReservation(): Promise<Result<void>>;
}

export interface PortAllocator {
  reserve(preferredPort: number | undefined): Promise<Result<PortLease>>;
}

export interface ProcessStart {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly executable: string;
  readonly projectRoot: string;
  readonly workingDirectory: string;
}

export interface ProcessOutput {
  readonly stderr: string;
  readonly stdout: string;
}

export interface ProcessExit {
  readonly cleanup: Result<void>;
  readonly exitCode: number;
}

export interface ProcessHandle {
  readonly exited: Promise<ProcessExit>;
  readonly leaderExited: Promise<number>;
  readonly output: Promise<Result<ProcessOutput>>;
  readonly pid: number;
  stop(): Promise<Result<void>>;
}

export interface ProcessHost {
  start(input: ProcessStart): Promise<Result<ProcessHandle>>;
}

export interface ProjectManagerOptions {
  readonly createId: () => string;
  readonly ports: PortAllocator;
  readonly processes: ProcessHost;
}

export interface CancellationSignal {
  readonly aborted: boolean;
}

export interface StartProjectInput {
  readonly environment: Readonly<Record<string, string>>;
  readonly environmentNamesCaseInsensitive: boolean;
  readonly root: string;
  readonly signal?: CancellationSignal;
  readonly spec: ProjectSpec;
}

export type ProjectCompletion =
  | { readonly kind: "natural"; readonly result: Result<void> }
  | { readonly kind: "stopped" };

export interface ManagedProject {
  readonly completed: Promise<ProjectCompletion>;
  readonly id: string;
  stop(): Promise<Result<void>>;
}

export interface ProjectCleanup {
  readonly id: string;
  stop(): Promise<Result<void>>;
}

export interface StartProjectFailure extends Failure {
  readonly cleanup?: ProjectCleanup;
}

export type StartProjectResult = StartProjectFailure | Success<ManagedProject>;

interface AllocatedEndpoint {
  readonly endpoint: ServiceEndpoint;
  readonly lease: PortLease;
}

interface ResourceRuntime {
  readonly endpoints: Map<string, AllocatedEndpoint>;
  readonly name: string;
  exitCode?: number;
  handle?: ProcessHandle;
  hasExited: boolean;
  state: ServiceState;
  stopRequested: boolean;
}

interface ProjectRuntime {
  readonly complete: (completion: ProjectCompletion) => void;
  readonly completed: Promise<ProjectCompletion>;
  readonly id: string;
  readonly name: string;
  readonly resources: ResourceRuntime[];
  readonly root: string;
  cleanup: Promise<Result<void>> | undefined;
  completionPublished: boolean;
  naturalCleanup: Promise<Result<void>> | undefined;
}

const compareNames = (left: string, right: string): number => left.localeCompare(right, "en");

export class ProjectManager {
  readonly #createId: () => string;
  readonly #ports: PortAllocator;
  readonly #processes: ProcessHost;
  readonly #projects = new Map<string, ProjectRuntime>();
  readonly #roots = new Map<string, ProjectRuntime>();

  constructor(options: ProjectManagerOptions) {
    this.#createId = options.createId;
    this.#ports = options.ports;
    this.#processes = options.processes;
  }

  listProjects(): ProjectList {
    return {
      projects: [...this.#projects.values()].map((project) => ({
        id: project.id,
        name: project.name,
        services: project.resources.map((resource) => ({
          endpoints: [...resource.endpoints.values()].map(({ endpoint }) => endpoint),
          ...(resource.exitCode === undefined ? {} : { exitCode: resource.exitCode }),
          name: resource.name,
          state: resource.state,
        })),
      })),
    };
  }

  async start(input: StartProjectInput): Promise<StartProjectResult> {
    if (this.#roots.has(input.root)) {
      return failure(
        createDiagnostic({
          code: "SYD4000",
          help: "Stop the active project before starting it again.",
          message: `Project '${input.spec.name}' is already running from this directory.`,
        }),
      );
    }

    const project = createProject(input, this.#createId());
    this.#roots.set(input.root, project);
    this.#projects.set(project.id, project);

    const canceled = cancellationFailure(input.signal);
    if (canceled) {
      return this.#rollbackStart(project, canceled);
    }

    const allocated = await this.#allocate(project, input.spec, input.signal);
    if (!allocated.success) {
      return this.#rollbackStart(project, allocated);
    }

    const prepared = this.#prepareStarts(project, input);
    if (!prepared.success) {
      return this.#rollbackStart(project, prepared);
    }

    const released = await this.#releaseReservations(project);
    if (!released.success) {
      return this.#rollbackStart(project, released);
    }

    const started = await this.#startResources(project, prepared.output, input.signal);
    if (!started.success) {
      return this.#rollbackStart(project, started);
    }

    const canceledAfterStart = cancellationFailure(input.signal);
    if (canceledAfterStart) {
      return this.#rollbackStart(project, canceledAfterStart);
    }

    this.#watch(project);
    return success(this.#managedProject(project));
  }

  async stopAll(): Promise<Result<void>> {
    const results = await Promise.all(
      [...this.#projects.values()].map((project) => this.#stop(project)),
    );
    const failed = results.find((result) => !result.success);
    return failed && !failed.success ? failed : success(undefined);
  }

  async #allocate(
    project: ProjectRuntime,
    spec: ProjectSpec,
    signal: CancellationSignal | undefined,
  ): Promise<Result<void>> {
    for (const resource of project.resources) {
      const resourceSpec = spec.resources[resource.name];
      if (!resourceSpec) {
        throw new Error("Runtime resource does not have a project specification.");
      }

      for (const [name, endpoint] of Object.entries(resourceSpec.endpoints).toSorted(
        ([left], [right]) => compareNames(left, right),
      )) {
        const canceled = cancellationFailure(signal);
        if (canceled) {
          return canceled;
        }
        const reserved = await this.#ports.reserve(endpoint.port.preferred);
        if (!reserved.success) {
          return reserved;
        }
        const lease = reserved.output;
        resource.endpoints.set(name, {
          endpoint: Object.freeze({ name, url: `http://${lease.host}:${lease.port}` }),
          lease,
        });
        const canceledAfterReservation = cancellationFailure(signal);
        if (canceledAfterReservation) {
          return canceledAfterReservation;
        }
      }
    }
    return success(undefined);
  }

  #prepareStarts(
    project: ProjectRuntime,
    input: StartProjectInput,
  ): Result<readonly ProcessStart[]> {
    const starts: ProcessStart[] = [];
    for (const resource of project.resources) {
      const spec = input.spec.resources[resource.name];
      if (!spec) {
        throw new Error("Runtime resource does not have a project specification.");
      }
      const environment = this.#resolveEnvironment(resource.name, spec, project, input);
      if (!environment.success) {
        resource.state = "failed";
        return environment;
      }
      starts.push({
        args: spec.command.args,
        env: environment.output,
        executable: spec.command.executable,
        projectRoot: project.root,
        workingDirectory: spec.cwd,
      });
    }
    return success(Object.freeze(starts));
  }

  async #releaseReservations(project: ProjectRuntime): Promise<Result<void>> {
    const results = await Promise.all(
      project.resources.flatMap((resource) =>
        [...resource.endpoints.values()].map((endpoint) => endpoint.lease.releaseReservation()),
      ),
    );
    const failed = results.find((result) => !result.success);
    return failed && !failed.success ? failed : success(undefined);
  }

  async #startResources(
    project: ProjectRuntime,
    starts: readonly ProcessStart[],
    signal: CancellationSignal | undefined,
  ): Promise<Result<void>> {
    for (const [index, resource] of project.resources.entries()) {
      const canceled = cancellationFailure(signal);
      if (canceled) {
        return canceled;
      }
      const start = starts[index];
      if (!start) {
        throw new Error("Prepared process start is missing.");
      }
      const started = await this.#processes.start(start);
      if (!started.success) {
        resource.state = "failed";
        return started;
      }
      resource.handle = started.output;
      resource.state = "running";
    }
    return success(undefined);
  }

  #resolveEnvironment(
    resourceName: string,
    resource: ProcessResourceSpec,
    project: ProjectRuntime,
    input: StartProjectInput,
  ): Result<Readonly<Record<string, string>>> {
    const environment: Record<string, string> = {};
    const environmentNames = input.environmentNamesCaseInsensitive
      ? new Map<string, string>()
      : undefined;
    for (const [name, value] of Object.entries(input.environment)) {
      setEnvironmentValue(environment, environmentNames, name, value);
    }

    const runtimeResource = project.resources.find(({ name }) => name === resourceName);
    if (!runtimeResource) {
      throw new Error("Runtime resource is missing from the project.");
    }
    for (const [name, endpoint] of Object.entries(resource.endpoints)) {
      const allocated = runtimeResource.endpoints.get(name);
      if (!allocated) {
        throw new Error("Allocated endpoint is missing from the runtime project.");
      }
      setEnvironmentValue(
        environment,
        environmentNames,
        endpoint.port.env,
        String(allocated.lease.port),
      );
    }

    for (const [name, value] of Object.entries(resource.env)) {
      const resolved =
        typeof value === "string" ? success(value) : resolveEndpointValue(value, project);
      if (!resolved.success) {
        return resolved;
      }
      setEnvironmentValue(environment, environmentNames, name, resolved.output);
    }
    return success(Object.freeze(environment));
  }

  #watch(project: ProjectRuntime): void {
    for (const resource of project.resources) {
      const handle = resource.handle;
      if (!handle) {
        continue;
      }
      void handle.leaderExited.then((exitCode) => {
        resource.exitCode = exitCode;
        if (resource.state === "running") {
          resource.state = "stopping";
        }
      });
      void handle.exited.then(({ cleanup, exitCode }) => {
        resource.exitCode = exitCode;
        resource.hasExited = true;
        if (resource.state === "running" || resource.state === "stopping") {
          resource.state =
            cleanup.success && (resource.stopRequested || exitCode === 0) ? "exited" : "failed";
        }
        void this.#completeIfTerminal(project);
      });
    }
  }

  async #completeIfTerminal(project: ProjectRuntime): Promise<void> {
    if (
      project.completionPublished ||
      project.cleanup ||
      project.resources.some((resource) => !resource.hasExited)
    ) {
      return;
    }
    project.completionPublished = true;
    const cleanup = this.#performNaturalCleanup(project);
    project.naturalCleanup = cleanup;
    const cleaned = await cleanup;
    if (project.naturalCleanup === cleanup) {
      project.naturalCleanup = undefined;
    }
    if (!cleaned.success) {
      project.complete({ kind: "natural", result: cleaned });
      return;
    }
    const failed = project.resources.find(({ exitCode }) => exitCode !== 0);
    if (!failed?.handle) {
      project.complete({ kind: "natural", result: success(undefined) });
      return;
    }
    const output = await failed.handle.output;
    if (!output.success) {
      project.complete({ kind: "natural", result: output });
      return;
    }
    const note = failureNote(output.output);
    project.complete({
      kind: "natural",
      result: failure(
        createDiagnostic({
          code: "SYD4006",
          help: "Fix the service error, then start the project again.",
          message: `Service '${failed.name}' exited with code ${failed.exitCode}.`,
          ...(note ? { notes: [note] } : {}),
        }),
      ),
    });
  }

  #stop(project: ProjectRuntime): Promise<Result<void>> {
    if (project.cleanup) {
      return project.cleanup;
    }
    const cleanup = this.#performStop(project);
    project.cleanup = cleanup;
    void cleanup.then((result) => {
      if (!result.success && project.cleanup === cleanup) {
        project.cleanup = undefined;
      }
    });
    return cleanup;
  }

  async #performStop(project: ProjectRuntime): Promise<Result<void>> {
    await project.naturalCleanup;
    const stopped = await this.#stopResources(project);
    if (!stopped.success) {
      return stopped;
    }
    const disposed = await this.#disposePorts(project);
    if (!disposed.success) {
      return disposed;
    }
    this.#forget(project);
    if (!project.completionPublished) {
      project.completionPublished = true;
      project.complete({ kind: "stopped" });
    }
    return success(undefined);
  }

  async #performNaturalCleanup(project: ProjectRuntime): Promise<Result<void>> {
    const stopped = await this.#stopResources(project);
    return stopped.success ? this.#disposePorts(project) : stopped;
  }

  async #stopResources(project: ProjectRuntime): Promise<Result<void>> {
    for (const resource of project.resources) {
      if (resource.handle && !resource.hasExited) {
        resource.stopRequested = true;
        resource.state = "stopping";
      }
    }

    const results = await Promise.all(
      project.resources.map(async (resource) => {
        if (!resource.handle) {
          return success(undefined);
        }
        const stopped = await resource.handle.stop();
        if (!stopped.success) {
          resource.state = "failed";
          return stopped;
        }

        const { exitCode } = await resource.handle.exited;
        resource.exitCode = exitCode;
        resource.hasExited = true;
        resource.state = resource.stopRequested || exitCode === 0 ? "exited" : "failed";
        return stopped;
      }),
    );
    const failed = results.find((result) => !result.success);
    return failed && !failed.success ? failed : success(undefined);
  }

  async #disposePorts(project: ProjectRuntime): Promise<Result<void>> {
    const results = await Promise.all(
      project.resources.flatMap((resource) =>
        [...resource.endpoints.values()].map((endpoint) => endpoint.lease.dispose()),
      ),
    );
    const failed = results.find((result) => !result.success);
    return failed && !failed.success ? failed : success(undefined);
  }

  async #rollbackStart(project: ProjectRuntime, cause: Failure): Promise<StartProjectFailure> {
    const stopped = await this.#stopResources(project);
    if (!stopped.success) {
      return this.#retainedStartFailure(project, stopped, cause);
    }
    const disposed = await this.#disposePorts(project);
    if (!disposed.success) {
      return this.#retainedStartFailure(project, disposed, cause);
    }
    this.#forget(project);
    return cause;
  }

  #managedProject(project: ProjectRuntime): ManagedProject {
    return Object.freeze({
      completed: project.completed,
      id: project.id,
      stop: () => this.#stop(project),
    });
  }

  #retainedStartFailure(
    project: ProjectRuntime,
    cleanupFailure: Failure,
    cause: Failure,
  ): StartProjectFailure {
    for (const resource of project.resources) {
      if (resource.state === "starting") {
        resource.state = "failed";
      }
    }
    const [first, ...remaining] = cleanupFailure.diagnostics;
    const combined = failure(first, ...remaining, ...cause.diagnostics);
    return Object.freeze({
      ...combined,
      cleanup: Object.freeze({
        id: project.id,
        stop: () => this.#stop(project),
      }),
    });
  }

  #forget(project: ProjectRuntime): void {
    if (this.#projects.get(project.id) === project) {
      this.#projects.delete(project.id);
    }
    if (this.#roots.get(project.root) === project) {
      this.#roots.delete(project.root);
    }
  }
}

function createProject(input: StartProjectInput, id: string): ProjectRuntime {
  let complete!: (completion: ProjectCompletion) => void;
  const completed = new Promise<ProjectCompletion>((resolve) => {
    complete = resolve;
  });
  return {
    complete,
    cleanup: undefined,
    completed,
    completionPublished: false,
    id,
    name: input.spec.name,
    resources: Object.keys(input.spec.resources)
      .toSorted(compareNames)
      .map((name) => ({
        endpoints: new Map(),
        hasExited: false,
        name,
        state: "starting",
        stopRequested: false,
      })),
    naturalCleanup: undefined,
    root: input.root,
  };
}

function cancellationFailure(signal: CancellationSignal | undefined): Failure | undefined {
  return signal?.aborted
    ? failure(
        createDiagnostic({
          code: "SYD4005",
          help: "Run the command again when the project should be started.",
          message: "Project startup was canceled before it completed.",
        }),
      )
    : undefined;
}

function resolveEndpointValue(
  expression: EndpointValueExpression,
  project: ProjectRuntime,
): Result<string> {
  const allocatedEndpoint = project.resources
    .find(({ name }) => name === expression.resource)
    ?.endpoints.get(expression.endpoint);
  if (!allocatedEndpoint) {
    return failure(
      createDiagnostic({
        code: "SYD4002",
        help: "Reference an endpoint defined by a service in this project.",
        message: `Endpoint '${expression.resource}.${expression.endpoint}' is not available in the active project.`,
      }),
    );
  }
  if (expression.kind === "endpoint-host") {
    return success(allocatedEndpoint.lease.host);
  }
  if (expression.kind === "endpoint-port") {
    return success(String(allocatedEndpoint.lease.port));
  }
  return success(allocatedEndpoint.endpoint.url);
}

function setEnvironmentValue(
  environment: Record<string, string>,
  environmentNames: Map<string, string> | undefined,
  name: string,
  value: string,
): void {
  if (environmentNames) {
    const normalized = environmentKey(name);
    const existing = environmentNames.get(normalized);
    if (existing && existing !== name) {
      delete environment[existing];
    }
    environmentNames.set(normalized, name);
  }
  environment[name] = value;
}

function failureNote(output: ProcessOutput): string | undefined {
  const text = output.stderr.trim() || output.stdout.trim();
  return text ? `Recent service output:\n${text}` : undefined;
}
