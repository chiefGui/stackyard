import { afterEach, describe, expect, test } from "bun:test";
import { Deferred, Effect, Fiber, Layer, ManagedRuntime } from "effect";

import {
  makeProjectCatalogLayer,
  makeProjectManagerLayer,
  PortAllocator,
  ProcessHost,
  ProjectCatalog,
  ProjectDefinitionLoader,
  ProjectDefinitionObserver,
  ProjectIdGenerator,
  ProjectManager,
  ProjectOrchestrator,
  ProjectOrchestratorLayer,
  ProjectRootResolver,
  ProjectStore,
  ResourceLogStore,
  type PortLease,
  type ProcessExit,
  type ProcessHandle,
  type ProcessLogLine,
  type ProcessStart,
  type ProjectDefinitionLoad,
  type ProjectRecord,
  type StartProjectFailure,
} from "../packages/control-plane/src/index.ts";
import {
  createDiagnostic,
  failure,
  success,
  type Failure,
  type Result,
} from "../packages/diagnostics/src/index.ts";
import { createProjectSpec, type ProjectSpec } from "../packages/protocol/src/index.ts";

const disposeRuntimes: Array<() => Promise<void>> = [];
const diagnostics = { report() {} };

afterEach(async () => {
  await Promise.all(disposeRuntimes.splice(0).map((dispose) => dispose()));
});

describe("project manager", () => {
  test("allocates endpoints before starting processes and resolves runtime environment", async () => {
    const ports = new FakePorts();
    const processes = new FakeProcesses(-1, () => {
      expect(ports.leases.every(({ released }) => released === 1)).toBeTrue();
    });
    const manager = await createManager(ports, processes);

    const started = await outcome(
      startProject(manager, "C:/project", projectSpec(), { INHERITED: "yes", path: "old" }),
    );
    expect(started.ok).toBeTrue();
    expect(ports.preferredPorts).toEqual([4100, 4200]);
    expect(ports.leases.every(({ released }) => released === 1)).toBeTrue();
    expect(processes.starts).toHaveLength(2);
    expect(processes.starts[0]).toMatchObject({
      env: { INHERITED: "yes", PATH: "new", PORT: "4100" },
      executable: "api-command",
      projectRoot: "C:/project",
      workingDirectory: "apps/api",
    });
    expect(processes.starts[0]?.env).not.toHaveProperty("path");
    expect(processes.starts[1]).toMatchObject({
      env: {
        API_HOST: "127.0.0.1",
        API_PORT: "4100",
        API_URL: "http://127.0.0.1:4100",
        INHERITED: "yes",
        path: "old",
        PORT: "4200",
      },
      executable: "web-command",
    });

    const projects = await Effect.runPromise(manager.listActiveProjects);
    expect(projects).toMatchObject({
      projects: [
        {
          name: "demo",
          services: [
            {
              endpoints: [{ name: "http", url: "http://127.0.0.1:4100" }],
              name: "api",
              state: "running",
            },
            {
              endpoints: [{ name: "http", url: "http://127.0.0.1:4200" }],
              name: "web",
              state: "running",
            },
          ],
        },
      ],
    });
  });

  test("rolls back partial startup and allows a clean retry", async () => {
    const ports = new FakePorts();
    const processes = new FakeProcesses(1);
    const manager = await createManager(ports, processes);

    const failed = await outcome(startProject(manager, "/project", projectSpec()));
    expect(failed).toMatchObject({ ok: false, error: { diagnostics: [{ code: "SYD4999" }] } });
    expect(processes.handles[0]?.stopCount).toBe(1);
    expect(ports.leases.every(({ disposed }) => disposed === 1)).toBeTrue();
    expect((await Effect.runPromise(manager.listActiveProjects)).projects).toEqual([]);

    expect((await outcome(startProject(manager, "/project", projectSpec()))).ok).toBeTrue();
  });

  test("returns an exact cleanup capability when failed startup retains ownership", async () => {
    const ports = new FakePorts();
    let processes!: FakeProcesses;
    processes = new FakeProcesses(1, () => {
      const handle = processes.handles[0];
      if (handle) {
        handle.stopFailures = 1;
      }
    });
    const manager = await createManager(ports, processes);

    const started = await outcome(startProject(manager, "/project", projectSpec()));
    expect(started.ok).toBeFalse();
    if (started.ok) {
      throw new Error("Expected startup to fail.");
    }
    expect(started.error.diagnostics.map(({ code }) => code)).toEqual(["SYD4998", "SYD4999"]);
    expect(started.error.cleanup?.id).toBeString();
    if (!started.error.cleanup) {
      throw new Error("Expected a retained cleanup capability.");
    }
    await Effect.runPromise(started.error.cleanup.stop);
    expect((await Effect.runPromise(manager.listActiveProjects)).projects).toEqual([]);
  });

  test("tracks independent exits and completes after every service exits", async () => {
    const ports = new FakePorts();
    const processes = new FakeProcesses();
    const manager = await createManager(ports, processes);
    const started = await expectStarted(startProject(manager, "/project", projectSpec()));

    processes.handles[0]?.exitLeader(7);
    await tick();
    expect(
      (await Effect.runPromise(manager.listActiveProjects)).projects[0]?.services.map(
        ({ state }) => state,
      ),
    ).toEqual(["stopping", "running"]);

    processes.handles[0]?.settle(7);
    processes.handles[1]?.exit(0);
    const completion = await Effect.runPromise(started.completed);
    expect(completion).toMatchObject({
      kind: "natural",
      result: { diagnostics: [{ code: "SYD4006" }], success: false },
    });
    expect(ports.leases.every(({ disposed }) => disposed === 1)).toBeTrue();
    expect((await Effect.runPromise(manager.listActiveProjects)).projects).toEqual([]);
    expect(
      (await Effect.runPromise(manager.listRecentProjects)).projects.map(({ id }) => id),
    ).toEqual([started.id]);
  });

  test("retains failed natural cleanup and permits an explicit retry", async () => {
    const ports = new FakePorts();
    const processes = new FakeProcesses();
    const manager = await createManager(ports, processes);
    const started = await expectStarted(startProject(manager, "/project", projectSpec()));
    const firstLease = ports.leases[0];
    if (!firstLease) {
      throw new Error("Expected the first port lease.");
    }
    firstLease.disposeFailures = 1;

    for (const handle of processes.handles) {
      handle.exit(0);
    }
    expect(await Effect.runPromise(started.completed)).toMatchObject({
      kind: "natural",
      result: { diagnostics: [{ code: "SYD4997" }], success: false },
    });
    expect((await Effect.runPromise(manager.listActiveProjects)).projects).toHaveLength(1);

    await Effect.runPromise(started.stop);
    expect(ports.leases.every(({ disposed }) => disposed === 1)).toBeTrue();
    expect((await Effect.runPromise(manager.listActiveProjects)).projects).toEqual([]);
    expect(
      (await Effect.runPromise(manager.listRecentProjects)).projects.map(({ id }) => id),
    ).toEqual([started.id]);
  });

  test("cancels an in-flight service start when the project is stopped", async () => {
    const entered = Deferred.makeUnsafe<void>();
    const gate = Deferred.makeUnsafe<void>();
    const handles: FakeHandle[] = [];
    const processes = ProcessHost.of({
      start: (input) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(gate);
          const handle = new FakeHandle(handles.length + 1, input);
          handles.push(handle);
          return handle;
        }),
    });
    const manager = await createManager(new FakePorts(), processes);
    const starting = Effect.runFork(
      outcomeEffect(startProject(manager, "/project", projectSpec())),
    );
    await Effect.runPromise(Deferred.await(entered));

    const stopping = Effect.runPromise(manager.stop("/project"));
    const [started] = await Promise.all([Effect.runPromise(Fiber.join(starting)), stopping]);

    expect(started.ok).toBeTrue();
    if (started.ok) {
      expect(await Effect.runPromise(started.value.completed)).toEqual({ kind: "stopped" });
    }
    expect(handles).toEqual([]);
    expect((await Effect.runPromise(manager.listActiveProjects)).projects).toEqual([]);
  });

  test("keeps supervising retained cleanup after a startup owner is interrupted", async () => {
    const entered = Deferred.makeUnsafe<void>();
    const handle = new FakeHandle(1, {
      args: [],
      env: {},
      executable: "api-command",
      logs: new ResourceLogStore().createFeed(),
      projectRoot: "/project",
      workingDirectory: ".",
    });
    handle.stopFailures = 1;
    let starts = 0;
    const processes = ProcessHost.of({
      start: () => {
        starts += 1;
        return starts === 1
          ? Effect.succeed<ProcessHandle>(handle)
          : Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
      },
    });
    const manager = await createManager(new FakePorts(), processes);
    const starting = Effect.runFork(startProject(manager, "/project", projectSpec()));
    await Effect.runPromise(Deferred.await(entered));

    await Effect.runPromise(Fiber.interrupt(starting));
    await waitUntil(async () =>
      (await Effect.runPromise(manager.listActiveProjects)).projects.length === 0
        ? true
        : undefined,
    );

    expect(handle.stopCount).toBe(2);
  });

  test("retains failed cleanup for inspection and permits a later retry", async () => {
    const ports = new FakePorts();
    const processes = new FakeProcesses();
    const manager = await createManager(ports, processes);
    const started = await expectStarted(startProject(manager, "/project", projectSpec()));
    const first = processes.handles[0];
    if (!first) {
      throw new Error("Expected the first process handle.");
    }
    first.stopFailures = 1;

    const failed = await outcome(started.stop);
    expect(failed).toMatchObject({ ok: false, error: { diagnostics: [{ code: "SYD4998" }] } });
    expect(ports.leases.every(({ disposed }) => disposed === 0)).toBeTrue();

    await Effect.runPromise(started.stop);
    expect(first.stopCount).toBe(2);
    expect(ports.leases.every(({ disposed }) => disposed === 1)).toBeTrue();
    expect(await Effect.runPromise(started.completed)).toEqual({ kind: "stopped" });
  });

  test("keeps bounded completed logs without keeping projects active", async () => {
    const processes = new FakeProcesses();
    const manager = await createManager(new FakePorts(), processes, { recentProjectLimit: 1 });
    const first = await expectStarted(startProject(manager, "/first", projectSpec()));
    processes.handles[0]?.write({ observedAt: 1, stream: "stdout", text: "listening" });
    const firstLogs = await Effect.runPromise(manager.getResourceLogs(first.id, "api"));
    await Effect.runPromise(first.stop);

    const second = await expectStarted(startProject(manager, "/second", projectSpec()));
    await Effect.runPromise(second.stop);

    expect(
      (await Effect.runPromise(manager.listRecentProjects)).projects.map(({ id }) => id),
    ).toEqual([second.id]);
    expect(await Effect.runPromise(manager.getResourceLogs(first.id, "api"))).toBeUndefined();
    expect(firstLogs?.snapshot().status).toBe("removed");
  });
});

describe("project catalog and orchestration", () => {
  test("persists canonical roots and refreshes definitions without re-adding", async () => {
    const harness = await createCatalogHarness();
    const added = await Effect.runPromise(harness.catalog.add("/input/project"));
    expect(added.definition.kind).toBe("valid");
    expect(harness.records).toEqual([{ id: "project-one", root: "/canonical/project" }]);

    harness.definition = {
      diagnostics: [createDiagnostic({ code: "SYD4996", message: "Expected invalid definition." })],
      kind: "invalid",
    };
    harness.change("/canonical/project");
    await tick();
    await tick();
    expect((await Effect.runPromise(harness.catalog.list))[0]).toMatchObject({
      definition: {
        diagnostics: [{ code: "SYD4996" }],
        kind: "invalid",
        lastValidSpec: { name: "demo" },
      },
    });

    await Effect.runPromise(harness.catalog.add("/input/project"));
    expect(harness.saveCount).toBe(1);
    await Effect.runPromise(harness.catalog.remove("project-one"));
    expect(harness.records).toEqual([]);
    expect(harness.closedRoots).toEqual(["/canonical/project"]);
  });

  test("keeps one durable project while definition and runtime state change", async () => {
    const state = createCatalogState();
    const ports = new FakePorts();
    const processes = new FakeProcesses();
    const runtime = createControlPlaneRuntime(state, ports, processes);
    const projects = await runtime.runPromise(ProjectOrchestrator);

    const missing = await outcome(
      projects.start({
        environment: {},
        environmentNamesCaseInsensitive: true,
        root: "/canonical/project",
      }),
    );
    expect(missing).toMatchObject({ ok: false, error: { diagnostics: [{ code: "SYD4100" }] } });

    const added = await Effect.runPromise(projects.add("/input/project"));
    expect(added).toMatchObject({
      id: "project-one",
      services: [
        { name: "api", state: "stopped" },
        { name: "web", state: "stopped" },
      ],
      state: "stopped",
    });

    const started = await Effect.runPromise(
      projects.start({
        environment: {},
        environmentNamesCaseInsensitive: true,
        root: "/canonical/project",
      }),
    );
    expect((await Effect.runPromise(projects.list))[0]).toMatchObject({
      id: "project-one",
      state: "running",
    });

    state.definition = { kind: "valid", spec: projectSpecWithWorker() };
    state.change("/canonical/project");
    await tick();
    await tick();
    expect((await Effect.runPromise(projects.list))[0]).toMatchObject({
      id: "project-one",
      restartRequired: true,
      services: [
        { name: "api", state: "running" },
        { name: "web", state: "running" },
        { name: "worker", state: "stopped" },
      ],
    });

    const refused = await outcome(projects.remove("project-one"));
    expect(refused).toMatchObject({ ok: false, error: { diagnostics: [{ code: "SYD4102" }] } });
    await Effect.runPromise(projects.stop("project-one"));
    expect(await Effect.runPromise(started.completed)).toEqual({ kind: "stopped" });
    await Effect.runPromise(projects.remove("project-one"));
  });
});

interface ManagerOptions {
  readonly recentProjectLimit?: number;
}

async function createManager(
  ports: FakePorts | PortAllocator["Service"],
  processes: FakeProcesses | ProcessHost["Service"],
  options: ManagerOptions = {},
): Promise<ProjectManager["Service"]> {
  const layer = makeProjectManagerLayer({ diagnostics, ...options }).pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(PortAllocator, ports instanceof FakePorts ? ports.service : ports),
        Layer.succeed(
          ProcessHost,
          processes instanceof FakeProcesses ? processes.service : processes,
        ),
      ),
    ),
  );
  const runtime = ManagedRuntime.make(layer);
  registerRuntime(runtime);
  return runtime.runPromise(ProjectManager);
}

interface CatalogState {
  readonly callbacks: Map<string, () => void>;
  readonly closedRoots: string[];
  definition: ProjectDefinitionLoad;
  records: readonly ProjectRecord[];
  saveCount: number;
  change(root: string): void;
}

function createCatalogState(): CatalogState {
  const state: CatalogState = {
    callbacks: new Map(),
    closedRoots: [],
    definition: { kind: "valid", spec: projectSpec() },
    records: [],
    saveCount: 0,
    change(root) {
      this.callbacks.get(root)?.();
    },
  };
  return state;
}

async function createCatalogHarness() {
  const state = createCatalogState();
  const runtime = ManagedRuntime.make(createCatalogLayer(state));
  registerRuntime(runtime);
  const catalog = await runtime.runPromise(ProjectCatalog);
  return {
    catalog,
    change: state.change.bind(state),
    closedRoots: state.closedRoots,
    get definition() {
      return state.definition;
    },
    set definition(value: ProjectDefinitionLoad) {
      state.definition = value;
    },
    get records() {
      return state.records;
    },
    get saveCount() {
      return state.saveCount;
    },
  };
}

function createCatalogLayer(state: CatalogState) {
  const dependencies = Layer.mergeAll(
    Layer.succeed(
      ProjectStore,
      ProjectStore.of({
        load: Effect.sync(() => state.records),
        save: (records) =>
          Effect.sync(() => {
            state.saveCount += 1;
            state.records = records;
          }),
      }),
    ),
    Layer.succeed(
      ProjectDefinitionLoader,
      ProjectDefinitionLoader.of({ load: () => Effect.sync(() => state.definition) }),
    ),
    Layer.succeed(
      ProjectDefinitionObserver,
      ProjectDefinitionObserver.of({
        observe: (root, onChange) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              state.callbacks.set(root, onChange);
            }),
            () =>
              Effect.sync(() => {
                state.closedRoots.push(root);
                state.callbacks.delete(root);
              }),
          ),
      }),
    ),
    Layer.succeed(
      ProjectRootResolver,
      ProjectRootResolver.of({ canonicalize: () => Effect.succeed("/canonical/project") }),
    ),
    Layer.succeed(
      ProjectIdGenerator,
      ProjectIdGenerator.of({ next: Effect.succeed("project-one") }),
    ),
  );
  return makeProjectCatalogLayer({ diagnostics: { report() {} } }).pipe(
    Layer.provide(dependencies),
  );
}

function createControlPlaneRuntime(
  state: CatalogState,
  ports: FakePorts,
  processes: FakeProcesses,
) {
  const manager = makeProjectManagerLayer({ diagnostics }).pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(PortAllocator, ports.service),
        Layer.succeed(ProcessHost, processes.service),
      ),
    ),
  );
  const controlPlane = ProjectOrchestratorLayer.pipe(
    Layer.provideMerge(Layer.merge(createCatalogLayer(state), manager)),
  );
  const runtime = ManagedRuntime.make(controlPlane);
  registerRuntime(runtime);
  return runtime;
}

function registerRuntime<R, E>(runtime: ManagedRuntime.ManagedRuntime<R, E>): void {
  disposeRuntimes.push(() => runtime.dispose());
}

function startProject(
  manager: ProjectManager["Service"],
  root: string,
  spec: ProjectSpec,
  environment: Readonly<Record<string, string>> = {},
) {
  return manager.start({
    environment,
    environmentNamesCaseInsensitive: true,
    id: root,
    revision: 1,
    root,
    spec,
  });
}

async function expectStarted(
  effect: Effect.Effect<
    import("../packages/control-plane/src/index.ts").ManagedProject,
    StartProjectFailure
  >,
) {
  const started = await outcome(effect);
  if (!started.ok) {
    throw new Error(`Expected project to start: ${started.error.diagnostics[0].message}`);
  }
  return started.value;
}

type Outcome<A, E> =
  | { readonly ok: false; readonly error: E }
  | { readonly ok: true; readonly value: A };

function outcomeEffect<A, E>(effect: Effect.Effect<A, E>): Effect.Effect<Outcome<A, E>> {
  return effect.pipe(
    Effect.match({
      onFailure: (error): Outcome<A, E> => ({ error, ok: false }),
      onSuccess: (value): Outcome<A, E> => ({ ok: true, value }),
    }),
  );
}

function outcome<A, E>(effect: Effect.Effect<A, E>): Promise<Outcome<A, E>> {
  return Effect.runPromise(outcomeEffect(effect));
}

function projectSpec(): ProjectSpec {
  const result = createProjectSpec({
    name: "demo",
    resources: {
      api: {
        command: { args: ["serve"], executable: "api-command" },
        cwd: "apps/api",
        endpoints: {
          http: { kind: "http", port: { env: "PORT", kind: "allocated", preferred: 4100 } },
        },
        env: { PATH: "new" },
        kind: "process",
      },
      web: {
        command: { args: [], executable: "web-command" },
        cwd: "apps/web",
        endpoints: {
          http: { kind: "http", port: { env: "PORT", kind: "allocated", preferred: 4200 } },
        },
        env: {
          API_HOST: { endpoint: "http", kind: "endpoint-host", resource: "api" },
          API_PORT: { endpoint: "http", kind: "endpoint-port", resource: "api" },
          API_URL: { endpoint: "http", kind: "endpoint-url", resource: "api" },
        },
        kind: "process",
      },
    },
  });
  if (!result.success) {
    throw new Error("Test project specification is invalid.");
  }
  return result.output;
}

function projectSpecWithWorker(): ProjectSpec {
  const current = projectSpec();
  const result = createProjectSpec({
    name: current.name,
    resources: {
      ...current.resources,
      worker: {
        command: { args: [], executable: "worker-command" },
        cwd: "apps/worker",
        endpoints: {},
        env: {},
        kind: "process",
      },
    },
  });
  if (!result.success) {
    throw new Error("Test project specification is invalid.");
  }
  return result.output;
}

class FakePorts {
  readonly leases: FakeLease[] = [];
  readonly preferredPorts: Array<number | undefined> = [];
  readonly service: PortAllocator["Service"];
  #nextPort = 5000;

  constructor(afterReserve?: () => void) {
    this.service = PortAllocator.of({
      reserve: (preferredPort) =>
        Effect.sync(() => {
          this.preferredPorts.push(preferredPort);
          const lease = new FakeLease(preferredPort ?? this.#nextPort++);
          this.leases.push(lease);
          afterReserve?.();
          return lease;
        }),
    });
  }
}

class FakeLease implements PortLease {
  readonly host = "127.0.0.1";
  disposeFailures = 0;
  disposed = 0;
  released = 0;

  constructor(readonly port: number) {}

  readonly dispose = Effect.suspend(() => {
    if (this.disposeFailures > 0) {
      this.disposeFailures -= 1;
      return Effect.fail(
        failure(createDiagnostic({ code: "SYD4997", message: "Expected dispose failure." })),
      );
    }
    this.disposed = 1;
    return Effect.void;
  });

  readonly releaseReservation = Effect.sync(() => {
    this.released = 1;
  });
}

class FakeProcesses {
  readonly handles: FakeHandle[] = [];
  readonly service: ProcessHost["Service"];
  readonly starts: ProcessStart[] = [];
  #failAt: number;

  constructor(failAt = -1, afterStart?: () => void) {
    this.#failAt = failAt;
    this.service = ProcessHost.of({
      start: (input) =>
        Effect.suspend(() => {
          const index = this.starts.length;
          this.starts.push(input);
          if (index === this.#failAt) {
            this.#failAt = -1;
            return Effect.fail(
              failure(createDiagnostic({ code: "SYD4999", message: "Expected start failure." })),
            );
          }
          const handle = new FakeHandle(index + 1, input);
          this.handles.push(handle);
          afterStart?.();
          return Effect.succeed<ProcessHandle>(handle);
        }),
    });
  }
}

class FakeHandle implements ProcessHandle {
  readonly #exited = Deferred.makeUnsafe<ProcessExit>();
  readonly #leaderExited = Deferred.makeUnsafe<number>();
  readonly exited = Deferred.await(this.#exited);
  readonly leaderExited = Deferred.await(this.#leaderExited);
  readonly stop: Effect.Effect<void, Failure>;
  stopFailures = 0;
  stopExitCode = 0;
  stopCount = 0;

  constructor(
    readonly pid: number,
    private readonly input: ProcessStart,
  ) {
    this.stop = Effect.suspend(() => {
      this.stopCount += 1;
      if (this.stopFailures > 0) {
        this.stopFailures -= 1;
        return Effect.fail(
          failure(createDiagnostic({ code: "SYD4998", message: "Expected stop failure." })),
        );
      }
      this.exit(this.stopExitCode);
      return Effect.void;
    });
  }

  exit(code: number, logCapture: Result<void> = success(undefined)): void {
    this.exitLeader(code);
    this.settle(code, logCapture);
  }

  exitLeader(code: number): void {
    Effect.runSync(Deferred.succeed(this.#leaderExited, code));
  }

  settle(code: number, logCapture: Result<void> = success(undefined)): void {
    Effect.runSync(
      Deferred.succeed(this.#exited, {
        cleanup: success(undefined),
        exitCode: code,
        logCapture,
      }),
    );
  }

  write(...entries: ProcessLogLine[]): void {
    this.input.logs.write(entries);
  }
}

async function tick(): Promise<void> {
  await Bun.sleep(0);
}

async function waitUntil(read: () => Promise<true | undefined>, attempts = 100): Promise<void> {
  if (await read()) {
    return;
  }
  if (attempts <= 1) {
    throw new Error("Timed out waiting for the expected control-plane state.");
  }
  await Bun.sleep(10);
  return waitUntil(read, attempts - 1);
}
