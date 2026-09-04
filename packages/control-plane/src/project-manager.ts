import {
  createDiagnostic,
  failure,
  reportDiagnostics,
  success,
  type DiagnosticSink,
  type Failure,
  type Result,
} from "@stackyard/diagnostics";
import {
  environmentKey,
  type EndpointValueExpression,
  type ProcessResourceSpec,
  type ProjectSpec,
} from "@stackyard/protocol";
import { Context, Deferred, Effect, Layer, Scope, Semaphore } from "effect";

import {
  type RuntimeProject,
  type RuntimeProjectList,
  type RuntimeServiceEndpoint,
  type RuntimeServiceState,
} from "./project-list.ts";
import {
  ResourceLogStore,
  type ResourceLogEntry,
  type ResourceLogFeed,
  type ResourceLogSource,
} from "./resource-logs.ts";

export interface PortLease {
  readonly dispose: Effect.Effect<void, Failure>;
  readonly host: string;
  readonly port: number;
  readonly releaseReservation: Effect.Effect<void, Failure>;
}

export class PortAllocator extends Context.Service<
  PortAllocator,
  {
    readonly reserve: (preferredPort: number | undefined) => Effect.Effect<PortLease, Failure>;
  }
>()("stackyard/control-plane/PortAllocator") {}

export interface ProcessStart {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly executable: string;
  readonly logs: ProcessLogSink;
  readonly projectRoot: string;
  readonly workingDirectory: string;
}

export interface ProcessLogLine {
  readonly observedAt: number;
  readonly stream: "stderr" | "stdout";
  readonly text: string;
  readonly truncatedBytes?: number;
}

export interface ProcessLogSink {
  write(entries: readonly ProcessLogLine[]): void;
}

export interface ProcessExit {
  readonly cleanup: Result<void>;
  readonly exitCode: number;
  readonly logCapture: Result<void>;
}

export interface ProcessHandle {
  readonly exited: Effect.Effect<ProcessExit>;
  readonly leaderExited: Effect.Effect<number>;
  readonly pid: number;
  readonly stop: Effect.Effect<void, Failure>;
}

export class ProcessHost extends Context.Service<
  ProcessHost,
  {
    readonly start: (input: ProcessStart) => Effect.Effect<ProcessHandle, Failure>;
  }
>()("stackyard/control-plane/ProcessHost") {}

export interface ProjectManagerOptions {
  readonly diagnostics: DiagnosticSink;
  readonly logs?: ResourceLogStore;
  readonly recentProjectLimit?: number;
}

export interface StartProjectInput {
  readonly environment: Readonly<Record<string, string>>;
  readonly environmentNamesCaseInsensitive: boolean;
  readonly id: string;
  readonly revision: number;
  readonly root: string;
  readonly spec: ProjectSpec;
}

export type ProjectCompletion =
  | { readonly kind: "natural"; readonly result: Result<void> }
  | { readonly kind: "stopped" };

export interface ManagedProject {
  readonly completed: Effect.Effect<ProjectCompletion>;
  readonly id: string;
  readonly name: string;
  readonly stop: Effect.Effect<void, Failure>;
}

export interface ProjectCleanup {
  readonly id: string;
  readonly stop: Effect.Effect<void, Failure>;
}

export interface StartProjectFailure extends Failure {
  readonly cleanup?: ProjectCleanup;
}

interface AllocatedEndpoint {
  readonly endpoint: RuntimeServiceEndpoint;
  readonly lease: PortLease;
}

interface ResourceRuntime {
  readonly endpoints: Map<string, AllocatedEndpoint>;
  readonly logs: ResourceLogFeed;
  readonly name: string;
  exit?: ProcessExit;
  exitCode?: number;
  handle?: ProcessHandle;
  state: RuntimeServiceState;
  stopRequested: boolean;
}

interface RecentProject {
  readonly id: string;
  readonly logs: ReadonlyMap<string, ResourceLogFeed>;
  readonly project: RuntimeProject;
  readonly root: string;
}

interface ProjectRuntime {
  readonly completed: Deferred.Deferred<ProjectCompletion>;
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  readonly resources: ResourceRuntime[];
  readonly root: string;
  readonly startSettled: Deferred.Deferred<void>;
  readonly stopSignal: Deferred.Deferred<void>;
  cleanup: Deferred.Deferred<Result<void>> | undefined;
  completionPublished: boolean;
  naturalCleanup: Deferred.Deferred<Result<void>> | undefined;
}

const compareNames = (left: string, right: string): number => left.localeCompare(right, "en");

export class ProjectManager extends Context.Service<
  ProjectManager,
  {
    readonly findActiveProject: (projectId: string) => Effect.Effect<RuntimeProject | undefined>;
    readonly getResourceLogs: (
      projectId: string,
      resourceName: string,
    ) => Effect.Effect<ResourceLogSource | undefined>;
    readonly isActive: (projectId: string) => Effect.Effect<boolean>;
    readonly listActiveProjects: Effect.Effect<RuntimeProjectList>;
    readonly listRecentProjects: Effect.Effect<RuntimeProjectList>;
    readonly start: (
      input: StartProjectInput,
    ) => Effect.Effect<ManagedProject, StartProjectFailure>;
    readonly stop: (projectId: string) => Effect.Effect<void, Failure>;
    readonly stopAll: Effect.Effect<void, Failure>;
  }
>()("stackyard/control-plane/ProjectManager") {}

export function makeProjectManagerLayer(
  options: ProjectManagerOptions,
): Layer.Layer<ProjectManager, never, PortAllocator | ProcessHost> {
  return Layer.effect(ProjectManager, makeProjectManager(options));
}

export const makeProjectManager = Effect.fn("makeProjectManager")(function* (
  options: ProjectManagerOptions,
): Effect.fn.Return<ProjectManager["Service"], never, PortAllocator | ProcessHost | Scope.Scope> {
  const ports = yield* PortAllocator;
  const processes = yield* ProcessHost;
  const scope = yield* Scope.Scope;
  const mutation = yield* Semaphore.make(1);
  const live = new ProjectManagerLive(
    options.logs ?? new ResourceLogStore(),
    options.diagnostics,
    mutation,
    ports,
    processes,
    positiveInteger(options.recentProjectLimit, 20, "recentProjectLimit"),
    scope,
  );
  yield* Effect.addFinalizer(() => retryCleanup(live.stopAll, options.diagnostics));
  return ProjectManager.of({
    findActiveProject: live.findActiveProject,
    getResourceLogs: live.getResourceLogs,
    isActive: live.isActive,
    listActiveProjects: live.listActiveProjects,
    listRecentProjects: live.listRecentProjects,
    start: live.start,
    stop: live.stop,
    stopAll: live.stopAll,
  });
});

class ProjectManagerLive {
  readonly #activeProjects = new Map<string, ProjectRuntime>();
  readonly #activeRoots = new Map<string, ProjectRuntime>();
  readonly #diagnostics: DiagnosticSink;
  readonly #logs: ResourceLogStore;
  readonly #mutation: Semaphore.Semaphore;
  readonly #ports: PortAllocator["Service"];
  readonly #processes: ProcessHost["Service"];
  readonly #recentProjectLimit: number;
  readonly #recentProjects = new Map<string, RecentProject>();
  readonly #recentRoots = new Map<string, RecentProject>();
  readonly #scope: Scope.Scope;

  constructor(
    logs: ResourceLogStore,
    diagnostics: DiagnosticSink,
    mutation: Semaphore.Semaphore,
    ports: PortAllocator["Service"],
    processes: ProcessHost["Service"],
    recentProjectLimit: number,
    scope: Scope.Scope,
  ) {
    this.#logs = logs;
    this.#diagnostics = diagnostics;
    this.#mutation = mutation;
    this.#ports = ports;
    this.#processes = processes;
    this.#recentProjectLimit = recentProjectLimit;
    this.#scope = scope;
  }

  readonly listActiveProjects: Effect.Effect<RuntimeProjectList> = Effect.sync(() =>
    this.#projectList(this.#activeProjects.values()),
  );

  readonly findActiveProject = Effect.fn("ProjectManager.findActiveProject")((projectId: string) =>
    Effect.sync(() => {
      const project = this.#activeProjects.get(projectId);
      return project ? this.#projectView(project) : undefined;
    }),
  );

  readonly isActive = Effect.fn("ProjectManager.isActive")((projectId: string) =>
    Effect.sync(() => this.#activeProjects.has(projectId)),
  );

  readonly listRecentProjects: Effect.Effect<RuntimeProjectList> = Effect.sync(() => ({
    projects: [...this.#recentProjects.values()].map(({ project }) => project),
  }));

  readonly getResourceLogs = Effect.fn("ProjectManager.getResourceLogs")(
    (projectId: string, resourceName: string) =>
      Effect.sync(() => {
        const active = this.#activeProjects.get(projectId);
        return (
          active?.resources.find(({ name }) => name === resourceName)?.logs ??
          this.#recentProjects.get(projectId)?.logs.get(resourceName)
        );
      }),
  );

  readonly start = Effect.fn("ProjectManager.start")(
    function* (
      this: ProjectManagerLive,
      input: StartProjectInput,
    ): Effect.fn.Return<ManagedProject, StartProjectFailure> {
      const project = yield* this.#mutation.withPermits(1)(
        Effect.gen(
          function* (this: ProjectManagerLive) {
            if (this.#activeRoots.has(input.root)) {
              return yield* Effect.fail(
                failure(
                  createDiagnostic({
                    code: "SYD4000",
                    help: "Stop the active project before starting it again.",
                    message: `Project '${input.spec.name}' is already running from this directory.`,
                  }),
                ),
              );
            }
            if (this.#activeProjects.has(input.id)) {
              return yield* Effect.fail(
                failure(
                  createDiagnostic({
                    code: "SYD4000",
                    help: "Stop the active project before starting it again.",
                    message: `Project '${input.spec.name}' is already running.`,
                  }),
                ),
              );
            }
            const created = yield* createProject(input, this.#logs);
            this.#activeRoots.set(input.root, created);
            this.#activeProjects.set(created.id, created);
            return created;
          }.bind(this),
        ),
      );

      return yield* this.#startProject(project, input).pipe(
        Effect.onInterrupt(() => this.#cleanupInterruptedStart(project)),
        Effect.ensuring(Deferred.succeed(project.startSettled, undefined)),
      );
    }.bind(this),
  );

  readonly stop = Effect.fn("ProjectManager.stop")(
    function* (this: ProjectManagerLive, projectId: string): Effect.fn.Return<void, Failure> {
      const project = yield* Effect.sync(() => this.#activeProjects.get(projectId));
      if (!project) {
        return undefined;
      }
      yield* Deferred.succeed(project.stopSignal, undefined);
      yield* Deferred.await(project.startSettled);
      if (this.#activeProjects.get(projectId) !== project) {
        return undefined;
      }
      return yield* this.#stop(project);
    }.bind(this),
  );

  readonly stopAll: Effect.Effect<void, Failure> = Effect.gen(
    function* (this: ProjectManagerLive) {
      const identifiers = [...this.#activeProjects.keys()];
      const results = yield* Effect.forEach(identifiers, (projectId) =>
        this.stop(projectId).pipe(
          Effect.match({ onFailure: (value) => value, onSuccess: success }),
        ),
      );
      const failed = results.find((result) => !result.success);
      if (failed && !failed.success) {
        return yield* Effect.fail(failed);
      }
      return undefined;
    }.bind(this),
  );

  #projectList(projects: Iterable<ProjectRuntime>): RuntimeProjectList {
    return { projects: [...projects].map((project) => this.#projectView(project)) };
  }

  #projectView(project: ProjectRuntime): RuntimeProject {
    return Object.freeze({
      id: project.id,
      name: project.name,
      revision: project.revision,
      root: project.root,
      services: Object.freeze(
        project.resources.map((resource) =>
          Object.freeze({
            endpoints: Object.freeze(
              [...resource.endpoints.values()].map(({ endpoint }) => endpoint),
            ),
            ...(resource.exitCode === undefined ? {} : { exitCode: resource.exitCode }),
            name: resource.name,
            state: resource.state,
          }),
        ),
      ),
    });
  }

  #startProject = Effect.fn("ProjectManager.startProject")(
    function* (
      this: ProjectManagerLive,
      project: ProjectRuntime,
      input: StartProjectInput,
    ): Effect.fn.Return<ManagedProject, StartProjectFailure> {
      const allocated = yield* this.#allocate(project, input.spec).pipe(toResultEffect);
      if (!allocated.success) {
        return yield* this.#resolveStartFailure(project, allocated);
      }

      const prepared = this.#prepareStarts(project, input);
      if (!prepared.success) {
        return yield* this.#resolveStartFailure(project, prepared);
      }

      const released = yield* this.#releaseReservations(project).pipe(toResultEffect);
      if (!released.success) {
        return yield* this.#resolveStartFailure(project, released);
      }

      const started = yield* this.#startResources(project, prepared.output).pipe(toResultEffect);
      if (!started.success) {
        return yield* this.#resolveStartFailure(project, started);
      }

      const canceled = yield* Deferred.isDone(project.stopSignal);
      if (canceled) {
        return yield* this.#resolveStartFailure(project, canceledFailure());
      }

      yield* this.#watch(project);
      return this.#managedProject(project);
    }.bind(this),
  );

  #allocate = Effect.fn("ProjectManager.allocate")(
    function* (
      this: ProjectManagerLive,
      project: ProjectRuntime,
      spec: ProjectSpec,
    ): Effect.fn.Return<void, Failure> {
      for (const resource of project.resources) {
        const resourceSpec = spec.resources[resource.name];
        if (!resourceSpec) {
          return yield* Effect.die(
            new Error("Runtime resource does not have a project specification."),
          );
        }
        for (const [name, endpoint] of Object.entries(resourceSpec.endpoints).toSorted(
          ([left], [right]) => compareNames(left, right),
        )) {
          yield* this.#ensureStarting(project);
          yield* Effect.uninterruptible(
            this.#ports.reserve(endpoint.port.preferred).pipe(
              Effect.tap((lease) =>
                Effect.sync(() => {
                  resource.endpoints.set(name, {
                    endpoint: Object.freeze({
                      name,
                      url: `http://${lease.host}:${lease.port}`,
                    }),
                    lease,
                  });
                }),
              ),
            ),
          );
          yield* this.#ensureStarting(project);
        }
      }
      return undefined;
    }.bind(this),
  );

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
        logs: resource.logs,
        projectRoot: project.root,
        workingDirectory: spec.cwd,
      });
    }
    return success(Object.freeze(starts));
  }

  #releaseReservations(project: ProjectRuntime): Effect.Effect<void, Failure> {
    return allCleanups(
      project.resources.flatMap((resource) =>
        [...resource.endpoints.values()].map(({ lease }) => lease.releaseReservation),
      ),
    );
  }

  #startResources = Effect.fn("ProjectManager.startResources")(
    function* (
      this: ProjectManagerLive,
      project: ProjectRuntime,
      starts: readonly ProcessStart[],
    ): Effect.fn.Return<void, Failure> {
      for (const [index, resource] of project.resources.entries()) {
        yield* this.#ensureStarting(project);
        const start = starts[index];
        if (!start) {
          return yield* Effect.die(new Error("Prepared process start is missing."));
        }
        const started = yield* this.#cancelWhenStopped(project, this.#processes.start(start)).pipe(
          Effect.tapError(() => Effect.sync(() => (resource.state = "failed"))),
        );
        resource.handle = started;
        resource.state = "running";
      }
      return undefined;
    }.bind(this),
  );

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

  #watch = Effect.fn("ProjectManager.watch")(
    function* (this: ProjectManagerLive, project: ProjectRuntime) {
      for (const resource of project.resources) {
        const handle = resource.handle;
        if (!handle) {
          continue;
        }
        yield* Effect.forkIn(
          handle.leaderExited.pipe(
            Effect.tap((exitCode) =>
              Effect.sync(() => {
                resource.exitCode = exitCode;
                if (resource.state === "running") {
                  resource.state = "stopping";
                }
              }),
            ),
          ),
          this.#scope,
        );
        yield* Effect.forkIn(
          handle.exited.pipe(
            Effect.tap((exit) =>
              Effect.sync(() => {
                this.#recordExit(resource, exit);
              }),
            ),
            Effect.andThen(this.#completeIfTerminal(project)),
          ),
          this.#scope,
        );
      }
    }.bind(this),
  );

  #completeIfTerminal = Effect.fn("ProjectManager.completeIfTerminal")(
    function* (this: ProjectManagerLive, project: ProjectRuntime) {
      const cleanup = yield* Deferred.make<Result<void>>();
      const ownsCleanup = yield* this.#mutation.withPermits(1)(
        Effect.sync(() => {
          if (
            project.completionPublished ||
            project.cleanup ||
            project.naturalCleanup ||
            project.resources.some((resource) => !resource.exit)
          ) {
            return false;
          }
          project.completionPublished = true;
          project.naturalCleanup = cleanup;
          return true;
        }),
      );
      if (!ownsCleanup) {
        return;
      }

      const cleaned = yield* this.#performNaturalCleanup(project).pipe(toResultEffect);
      yield* Deferred.succeed(cleanup, cleaned);
      if (!cleaned.success) {
        yield* Deferred.succeed(project.completed, { kind: "natural", result: cleaned });
        return;
      }
      const captureFailure = project.resources.find(({ exit }) => exit && !exit.logCapture.success)
        ?.exit?.logCapture;
      if (captureFailure && !captureFailure.success) {
        yield* Deferred.succeed(project.completed, {
          kind: "natural",
          result: captureFailure,
        });
        return;
      }
      const failed = project.resources.find(({ exitCode }) => exitCode !== 0);
      if (!failed) {
        yield* Deferred.succeed(project.completed, {
          kind: "natural",
          result: success(undefined),
        });
        return;
      }
      const note = failureNote(failed.logs);
      yield* Deferred.succeed(project.completed, {
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
    }.bind(this),
  );

  #stop = Effect.fn("ProjectManager.stopProject")(
    function* (this: ProjectManagerLive, project: ProjectRuntime): Effect.fn.Return<void, Failure> {
      const proposed = yield* Deferred.make<Result<void>>();
      const selected = yield* this.#mutation.withPermits(1)(
        Effect.sync(() => {
          if (project.cleanup) {
            return { cleanup: project.cleanup, owner: false } as const;
          }
          project.cleanup = proposed;
          return { cleanup: proposed, owner: true } as const;
        }),
      );
      if (!selected.owner) {
        return yield* Deferred.await(selected.cleanup).pipe(Effect.flatMap(fromResultEffect));
      }

      const result = yield* this.#performStop(project).pipe(toResultEffect);
      yield* Deferred.succeed(proposed, result);
      if (!result.success) {
        yield* this.#mutation.withPermits(1)(
          Effect.sync(() => {
            if (project.cleanup === proposed) {
              project.cleanup = undefined;
            }
          }),
        );
        return yield* Effect.fail(result);
      }
      return undefined;
    }.bind(this),
  );

  #performStop = Effect.fn("ProjectManager.performStop")(
    function* (this: ProjectManagerLive, project: ProjectRuntime): Effect.fn.Return<void, Failure> {
      if (project.naturalCleanup) {
        const naturalCleanup = yield* Deferred.await(project.naturalCleanup);
        if (naturalCleanup.success) {
          return;
        }
      }
      yield* this.#stopResources(project);
      yield* this.#disposePorts(project);
      this.#archive(project);
      if (!project.completionPublished) {
        project.completionPublished = true;
        yield* Deferred.succeed(project.completed, { kind: "stopped" });
      }
    }.bind(this),
  );

  #performNaturalCleanup = Effect.fn("ProjectManager.performNaturalCleanup")(
    function* (this: ProjectManagerLive, project: ProjectRuntime): Effect.fn.Return<void, Failure> {
      yield* this.#stopResources(project);
      yield* this.#disposePorts(project);
      this.#archive(project);
    }.bind(this),
  );

  #stopResources = Effect.fn("ProjectManager.stopResources")(
    function* (this: ProjectManagerLive, project: ProjectRuntime): Effect.fn.Return<void, Failure> {
      for (const resource of project.resources) {
        if (resource.handle && !resource.exit) {
          resource.stopRequested = true;
          resource.state = "stopping";
        }
      }

      const results = yield* Effect.forEach(project.resources, (resource) => {
        const handle = resource.handle;
        if (!handle) {
          return Effect.succeed(success(undefined));
        }
        return handle.stop.pipe(
          Effect.tapError(() => Effect.sync(() => (resource.state = "failed"))),
          Effect.andThen(handle.exited),
          Effect.tap((exit) => Effect.sync(() => this.#recordExit(resource, exit))),
          Effect.asVoid,
          Effect.match({ onFailure: (value) => value, onSuccess: success }),
        );
      });
      const failed = results.find((result) => !result.success);
      if (failed && !failed.success) {
        return yield* Effect.fail(failed);
      }
      return undefined;
    }.bind(this),
  );

  #disposePorts(project: ProjectRuntime): Effect.Effect<void, Failure> {
    return allCleanups(
      project.resources.flatMap((resource) =>
        [...resource.endpoints.values()].map(({ lease }) => lease.dispose),
      ),
    );
  }

  #rollbackStart = Effect.fn("ProjectManager.rollbackStart")(
    function* (
      this: ProjectManagerLive,
      project: ProjectRuntime,
      cause: Failure,
    ): Effect.fn.Return<StartProjectFailure> {
      const stopped = yield* this.#stopResources(project).pipe(toResultEffect);
      if (!stopped.success) {
        return this.#retainedStartFailure(project, stopped, cause);
      }
      const disposed = yield* this.#disposePorts(project).pipe(toResultEffect);
      if (!disposed.success) {
        return this.#retainedStartFailure(project, disposed, cause);
      }
      for (const resource of project.resources) {
        if (resource.state === "starting") {
          resource.state = "failed";
        }
      }
      if (
        project.resources.some(
          ({ logs }) => logs.hasObservedEntries() || logs.snapshot().status === "failed",
        )
      ) {
        this.#archive(project);
      } else {
        this.#discard(project);
      }
      return cause;
    }.bind(this),
  );

  #resolveStartFailure = Effect.fn("ProjectManager.resolveStartFailure")(
    function* (
      this: ProjectManagerLive,
      project: ProjectRuntime,
      cause: Failure,
    ): Effect.fn.Return<ManagedProject, StartProjectFailure> {
      const failed = yield* this.#rollbackStart(project, cause);
      const stopped = yield* Deferred.isDone(project.stopSignal);
      if (!stopped || failed.cleanup) {
        return yield* Effect.fail(failed);
      }
      if (!project.completionPublished) {
        project.completionPublished = true;
        yield* Deferred.succeed(project.completed, { kind: "stopped" });
      }
      return this.#managedProject(project);
    }.bind(this),
  );

  #cleanupInterruptedStart = Effect.fn("ProjectManager.cleanupInterruptedStart")(
    function* (this: ProjectManagerLive, project: ProjectRuntime) {
      const failed = yield* this.#resolveStartFailure(project, canceledFailure()).pipe(
        Effect.match({ onFailure: (value) => value, onSuccess: () => undefined }),
      );
      if (!failed?.cleanup) {
        return;
      }
      yield* Effect.forkIn(retryCleanup(failed.cleanup.stop, this.#diagnostics), this.#scope);
    }.bind(this),
  );

  #managedProject(project: ProjectRuntime): ManagedProject {
    return Object.freeze({
      completed: Deferred.await(project.completed),
      id: project.id,
      name: project.name,
      stop: this.stop(project.id),
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
      cleanup: Object.freeze({ id: project.id, stop: this.#stop(project) }),
    });
  }

  #recordExit(resource: ResourceRuntime, exit: ProcessExit): void {
    resource.exitCode = exit.exitCode;
    resource.exit = exit;
    resource.logs.complete(exit.logCapture);
    if (resource.state === "running" || resource.state === "stopping") {
      resource.state =
        exit.cleanup.success &&
        exit.logCapture.success &&
        (resource.stopRequested || exit.exitCode === 0)
          ? "exited"
          : "failed";
    }
  }

  #archive(project: ProjectRuntime): void {
    this.#removeActive(project);
    for (const resource of project.resources) {
      resource.logs.complete();
      delete resource.handle;
    }
    const recent: RecentProject = {
      id: project.id,
      logs: new Map(project.resources.map(({ logs, name }) => [name, logs])),
      project: this.#projectView(project),
      root: project.root,
    };
    const previous = this.#recentRoots.get(project.root);
    if (previous) {
      this.#removeRecent(previous);
    }
    this.#recentProjects.set(project.id, recent);
    this.#recentRoots.set(project.root, recent);
    while (this.#recentProjects.size > this.#recentProjectLimit) {
      const oldest = this.#recentProjects.values().next().value;
      if (!oldest) {
        break;
      }
      this.#removeRecent(oldest);
    }
  }

  #discard(project: ProjectRuntime): void {
    this.#removeActive(project);
    for (const resource of project.resources) {
      resource.logs.remove();
      delete resource.handle;
    }
  }

  #removeActive(project: ProjectRuntime): void {
    if (this.#activeProjects.get(project.id) === project) {
      this.#activeProjects.delete(project.id);
    }
    if (this.#activeRoots.get(project.root) === project) {
      this.#activeRoots.delete(project.root);
    }
  }

  #removeRecent(project: RecentProject): void {
    if (this.#recentProjects.get(project.id) === project) {
      this.#recentProjects.delete(project.id);
    }
    if (this.#recentRoots.get(project.root) === project) {
      this.#recentRoots.delete(project.root);
    }
    for (const logs of project.logs.values()) {
      logs.remove();
    }
  }

  #ensureStarting(project: ProjectRuntime): Effect.Effect<void, Failure> {
    return Deferred.isDone(project.stopSignal).pipe(
      Effect.flatMap((stopped) => (stopped ? Effect.fail(canceledFailure()) : Effect.void)),
    );
  }

  #cancelWhenStopped<A, E>(
    project: ProjectRuntime,
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<A, E | Failure> {
    return Effect.raceFirst(
      effect,
      Deferred.await(project.stopSignal).pipe(Effect.andThen(Effect.fail(canceledFailure()))),
    );
  }
}

const createProject = Effect.fn("createProject")(function* (
  input: StartProjectInput,
  logs: ResourceLogStore,
): Effect.fn.Return<ProjectRuntime> {
  return {
    cleanup: undefined,
    completed: yield* Deferred.make<ProjectCompletion>(),
    completionPublished: false,
    id: input.id,
    name: input.spec.name,
    naturalCleanup: undefined,
    revision: input.revision,
    resources: Object.keys(input.spec.resources)
      .toSorted(compareNames)
      .map((name) => ({
        endpoints: new Map(),
        logs: logs.createFeed(),
        name,
        state: "starting",
        stopRequested: false,
      })),
    root: input.root,
    startSettled: yield* Deferred.make<void>(),
    stopSignal: yield* Deferred.make<void>(),
  };
});

function canceledFailure(): Failure {
  return failure(
    createDiagnostic({
      code: "SYD4005",
      help: "Run the command again when the project should be started.",
      message: "Project startup was canceled before it completed.",
    }),
  );
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

function failureNote(logs: ResourceLogSource): string | undefined {
  const entries = logs.snapshot().entries;
  const text =
    recentOutput(entries, "stderr", 16 * 1024) || recentOutput(entries, "stdout", 16 * 1024);
  return text ? `Recent service output:\n${text}` : undefined;
}

function recentOutput(
  entries: readonly ResourceLogEntry[],
  stream: "stderr" | "stdout",
  limit: number,
): string {
  const lines: string[] = [];
  let length = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.stream !== stream) {
      continue;
    }
    const separatorLength = lines.length > 0 ? 1 : 0;
    const available = limit - length - separatorLength;
    if (available <= 0) {
      break;
    }
    const line = textTail(entry.text, available);
    lines.push(line);
    length += separatorLength + line.length;
    if (line.length < entry.text.length) {
      break;
    }
  }
  return lines.toReversed().join("\n").trim();
}

function textTail(text: string, maximumCodeUnits: number): string {
  let start = Math.max(0, text.length - maximumCodeUnits);
  const first = text.charCodeAt(start);
  const previous = text.charCodeAt(start - 1);
  if (first >= 0xdc00 && first <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) {
    start += 1;
  }
  return text.slice(start);
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return resolved;
}

function fromResultEffect<T>(result: Result<T>): Effect.Effect<T, Failure> {
  return result.success ? Effect.succeed(result.output) : Effect.fail(result);
}

function toResultEffect<T>(effect: Effect.Effect<T, Failure>): Effect.Effect<Result<T>> {
  return effect.pipe(Effect.match({ onFailure: (value) => value, onSuccess: success }));
}

function allCleanups(
  effects: readonly Effect.Effect<void, Failure>[],
): Effect.Effect<void, Failure> {
  return Effect.forEach(effects, (effect) => effect.pipe(toResultEffect)).pipe(
    Effect.flatMap((results) => {
      const failed = results.find((result) => !result.success);
      return failed && !failed.success ? Effect.fail(failed) : Effect.void;
    }),
  );
}

const retryCleanup = Effect.fn("ProjectManager.retryCleanup")(function* (
  cleanup: Effect.Effect<void, Failure>,
  diagnostics: DiagnosticSink,
) {
  let delay = 100;
  let reported = false;
  while (true) {
    const result = yield* cleanup.pipe(
      Effect.match({ onFailure: (value) => value, onSuccess: success }),
    );
    if (result.success) {
      return;
    }
    if (!reported) {
      reportDiagnostics(diagnostics, result.diagnostics);
      reported = true;
    }
    yield* Effect.sleep(`${delay} millis`);
    delay = Math.min(delay * 2, 2_000);
  }
});
