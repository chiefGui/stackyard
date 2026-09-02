import { describe, expect, test } from "bun:test";

import {
  ProjectManager,
  ProjectCatalog,
  ProjectOrchestrator,
  type ProjectDefinitionLoad,
  type ProjectDefinitionObservation,
  type ProjectRecord,
  type ProjectStore,
  type PortAllocator,
  type PortLease,
  type ProcessExit,
  type ProcessHandle,
  type ProcessHost,
  type ProcessLogLine,
  type ProcessStart,
} from "../packages/control-plane/src/index.ts";
import {
  createDiagnostic,
  failure,
  success,
  type Result,
} from "../packages/diagnostics/src/index.ts";
import { createProjectSpec, type ProjectSpec } from "../packages/protocol/src/index.ts";

describe("project manager", () => {
  test("allocates every endpoint before starting processes and resolves runtime environment", async () => {
    const ports = new FakePorts();
    const processes = new FakeProcesses(-1, () => {
      expect(ports.leases.every(({ released }) => released === 1)).toBeTrue();
    });
    const manager = createManager(ports, processes);
    const spec = projectSpec();

    const started = await startProject(manager, "C:/project", spec, {
      INHERITED: "yes",
      path: "old",
    });
    expect(started.success).toBeTrue();
    expect(ports.preferredPorts).toEqual([4100, 4200]);
    expect(ports.leases.every(({ released }) => released === 1)).toBeTrue();
    expect(processes.starts).toHaveLength(2);

    expect(processes.starts[0]).toMatchObject({
      env: {
        INHERITED: "yes",
        PORT: "4100",
        PATH: "new",
      },
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

    const projects = manager.listActiveProjects();
    expect(projects).not.toHaveProperty("schemaVersion");
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

  test("starts only services configured for automatic startup", async () => {
    const ports = new FakePorts();
    const processes = new FakeProcesses();
    const manager = createManager(ports, processes);

    const started = await startProject(manager, "/project", projectSpecWithManualWeb());

    expect(started.success).toBeTrue();
    expect(processes.starts.map(({ executable }) => executable)).toEqual(["api-command"]);
    expect(ports.preferredPorts).toEqual([4100]);
    expect(manager.listActiveProjects().projects[0]?.services).toMatchObject([
      { name: "api", startup: "automatic", state: "running" },
    ]);
    if (started.success) {
      expect((await started.output.stop()).success).toBeTrue();
    }
  });

  test("explains when a project has no automatically started services", async () => {
    const ports = new FakePorts();
    const processes = new FakeProcesses();
    const manager = createManager(ports, processes);

    const started = await startProject(manager, "/project", projectSpecWithOnlyManualServices());

    expect(started).toMatchObject({
      diagnostics: [{ code: "SYD4009" }],
      success: false,
    });
    expect(ports.leases).toEqual([]);
    expect(processes.starts).toEqual([]);
    expect(manager.listActiveProjects().projects).toEqual([]);
  });

  test("rolls back started siblings when an initial process cannot start", async () => {
    const ports = new FakePorts();
    const processes = new FakeProcesses(1);
    const manager = createManager(ports, processes);

    const started = await startProject(manager, "/project", projectSpec());

    expect(started.success).toBeFalse();
    if (!started.success) {
      expect(started.diagnostics[0].code).toBe("SYD4999");
    }
    expect(processes.handles[0]?.stopCount).toBe(1);
    expect(ports.leases.every(({ disposed }) => disposed === 1)).toBeTrue();
    expect(manager.listActiveProjects().projects).toEqual([]);

    expect((await startProject(manager, "/project", projectSpec())).success).toBeTrue();
  });

  test("returns an exact cleanup lease when failed startup retains ownership", async () => {
    const ports = new FakePorts();
    const processes = new FakeProcesses(1, () => {
      const handle = processes.handles[0];
      if (handle) {
        handle.stopFailures = 1;
      }
    });
    const manager = createManager(ports, processes);

    const started = await startProject(manager, "/project", projectSpec());

    expect(manager.listActiveProjects().projects).toHaveLength(1);
    expect(started.success).toBeFalse();
    if (!started.success) {
      expect(started.diagnostics.map(({ code }) => code)).toEqual(["SYD4998", "SYD4999"]);
      expect(started.cleanup?.id).toBeString();
      expect((await started.cleanup?.stop())?.success).toBeTrue();
    }
    expect(manager.listActiveProjects().projects).toEqual([]);
  });

  test("reports later exits independently and completes after every service exits", async () => {
    const ports = new FakePorts();
    const processes = new FakeProcesses();
    const manager = createManager(ports, processes);
    const started = await startProject(manager, "/project", projectSpec());
    if (!started.success) {
      throw new Error("Expected project to start.");
    }

    processes.handles[0]?.exitLeader(7);
    await tick();
    expect(manager.listActiveProjects().projects[0]?.services.map(({ state }) => state)).toEqual([
      "stopping",
      "running",
    ]);
    expect(manager.listActiveProjects().projects[0]?.services[0]?.exitCode).toBe(7);
    expect(processes.handles[1]?.stopCount).toBe(0);

    processes.handles[0]?.settle(7);
    await tick();
    expect(manager.listActiveProjects().projects[0]?.services.map(({ state }) => state)).toEqual([
      "failed",
      "running",
    ]);
    expect(processes.handles[1]?.stopCount).toBe(0);

    processes.handles[1]?.exit(0);
    const completion = await started.output.completed;
    expect(completion.kind).toBe("natural");
    if (completion.kind === "natural") {
      expect(completion.result.success).toBeFalse();
      if (!completion.result.success) {
        expect(completion.result.diagnostics[0].code).toBe("SYD4006");
      }
    }
    expect(ports.leases.every(({ disposed }) => disposed === 1)).toBeTrue();
  });

  test("rejects duplicate roots and makes cleanup idempotent", async () => {
    const ports = new FakePorts();
    const processes = new FakeProcesses();
    const manager = createManager(ports, processes);
    const first = await startProject(manager, "/project", projectSpec());
    if (!first.success) {
      throw new Error("Expected project to start.");
    }

    const duplicate = await startProject(manager, "/project", projectSpec());
    expect(duplicate.success).toBeFalse();
    if (!duplicate.success) {
      expect(duplicate.diagnostics[0].code).toBe("SYD4000");
      expect(duplicate.cleanup).toBeUndefined();
    }
    expect(processes.handles.every(({ stopCount }) => stopCount === 0)).toBeTrue();

    const [left, right] = await Promise.all([first.output.stop(), first.output.stop()]);
    expect(left.success).toBeTrue();
    expect(right.success).toBeTrue();
    expect(processes.handles.every(({ stopCount }) => stopCount === 1)).toBeTrue();
    expect(manager.listActiveProjects().projects).toEqual([]);
  });

  test("stops a project safely while its services are still starting", async () => {
    const gate = deferred();
    const entered = deferred();
    const handles: FakeHandle[] = [];
    const processes: ProcessHost = {
      async start(input) {
        entered.resolve();
        await gate.promise;
        const handle = new FakeHandle(handles.length + 1, input);
        handles.push(handle);
        return success<ProcessHandle>(handle);
      },
    };
    const manager = createManager(new FakePorts(), processes);
    const starting = startProject(manager, "/project", projectSpec());
    await entered.promise;

    const stopping = manager.stop("/project");
    gate.resolve();
    const [started, stopped] = await Promise.all([starting, stopping]);

    expect(started.success).toBeTrue();
    expect(stopped).toEqual({ output: undefined, success: true });
    if (started.success) {
      expect(await started.output.completed).toEqual({ kind: "stopped" });
    }
    expect(handles.map(({ stopCount }) => stopCount)).toEqual([1]);
    expect(manager.listActiveProjects().projects).toEqual([]);
    expect(await manager.stop("/project")).toEqual({ output: undefined, success: true });
  });

  test("retains failed cleanup for inspection and permits a later retry", async () => {
    const ports = new FakePorts();
    const processes = new FakeProcesses();
    const manager = createManager(ports, processes);
    const started = await startProject(manager, "/project", projectSpec());
    if (!started.success) {
      throw new Error("Expected project to start.");
    }
    const firstHandle = processes.handles[0];
    if (!firstHandle) {
      throw new Error("Expected the first service process to exist.");
    }
    firstHandle.stopFailures = 1;

    const firstStop = await started.output.stop();

    expect(firstStop.success).toBeFalse();
    expect(manager.listActiveProjects().projects[0]?.services.map(({ state }) => state)).toEqual([
      "failed",
      "exited",
    ]);
    expect(ports.leases.every(({ disposed }) => disposed === 0)).toBeTrue();

    const secondStop = await started.output.stop();
    expect(secondStop.success).toBeTrue();
    expect(firstHandle.stopCount).toBe(2);
    expect(ports.leases.every(({ disposed }) => disposed === 1)).toBeTrue();
    expect(manager.listActiveProjects().projects).toEqual([]);
    expect(await started.output.completed).toEqual({ kind: "stopped" });
  });

  test("does not report a successful requested termination as a service failure", async () => {
    const ports = new FakePorts();
    const processes = new FakeProcesses();
    const manager = createManager(ports, processes);
    const started = await startProject(manager, "/project", projectSpec());
    if (!started.success) {
      throw new Error("Expected project to start.");
    }
    for (const handle of processes.handles) {
      handle.stopExitCode = 143;
    }
    const firstLease = ports.leases[0];
    if (!firstLease) {
      throw new Error("Expected an allocated endpoint.");
    }
    firstLease.disposeFailures = 1;

    const stopped = await started.output.stop();

    expect(stopped.success).toBeFalse();
    expect(manager.listActiveProjects().projects[0]?.services.map(({ state }) => state)).toEqual([
      "exited",
      "exited",
    ]);
    expect((await started.output.stop()).success).toBeTrue();
  });

  test("rolls back processes when their owner disconnects during startup", async () => {
    const ports = new FakePorts();
    const cancellation = new AbortController();
    let processes!: FakeProcesses;
    processes = new FakeProcesses(-1, () => {
      processes.starts[0]?.logs.write([
        { observedAt: 1, stream: "stdout", text: "started before cancellation" },
      ]);
      cancellation.abort();
    });
    const manager = createManager(ports, processes);

    const started = await manager.start({
      environment: {},
      environmentNamesCaseInsensitive: false,
      id: "/project",
      revision: 1,
      root: "/project",
      signal: cancellation.signal,
      spec: projectSpec(),
    });

    expect(started.success).toBeFalse();
    if (!started.success) {
      expect(started.diagnostics[0].code).toBe("SYD4005");
    }
    expect(processes.handles).toHaveLength(1);
    expect(processes.handles[0]?.stopCount).toBe(1);
    expect(ports.leases.every(({ disposed }) => disposed === 1)).toBeTrue();
    expect(manager.listActiveProjects().projects).toEqual([]);
    expect(manager.listRecentProjects().projects[0]?.services.map(({ state }) => state)).toEqual([
      "exited",
      "failed",
    ]);
  });

  test("stops endpoint allocation promptly when startup is canceled", async () => {
    const cancellation = new AbortController();
    const ports = new FakePorts(() => cancellation.abort());
    const processes = new FakeProcesses();
    const manager = createManager(ports, processes);

    const started = await manager.start({
      environment: {},
      environmentNamesCaseInsensitive: false,
      id: "/project",
      revision: 1,
      root: "/project",
      signal: cancellation.signal,
      spec: projectSpec(),
    });

    expect(started.success).toBeFalse();
    if (!started.success) {
      expect(started.diagnostics[0].code).toBe("SYD4005");
    }
    expect(ports.leases).toHaveLength(1);
    expect(ports.leases[0]?.disposed).toBe(1);
    expect(processes.starts).toEqual([]);
    expect(manager.listActiveProjects().projects).toEqual([]);
  });

  test("serializes an explicit stop behind natural cleanup", async () => {
    const ports = new FakePorts();
    const processes = new FakeProcesses();
    const manager = createManager(ports, processes);
    const started = await startProject(manager, "/project", projectSpec());
    if (!started.success) {
      throw new Error("Expected project to start.");
    }
    const gate = deferred();
    const firstHandle = processes.handles[0];
    if (!firstHandle) {
      throw new Error("Expected the first service process to exist.");
    }
    firstHandle.stopGate = gate.promise;

    processes.handles[0]?.exit(0);
    processes.handles[1]?.exit(0);
    await tick();
    expect(firstHandle.stopCount).toBe(1);

    const stopping = started.output.stop();
    await tick();
    expect(firstHandle.stopCount).toBe(1);

    gate.resolve();
    expect((await stopping).success).toBeTrue();
    expect(firstHandle.stopCount).toBe(2);
    expect(manager.listActiveProjects().projects).toEqual([]);
  });

  test("uses the live resource feed for failure diagnostics", async () => {
    const processes = new FakeProcesses();
    const manager = createManager(new FakePorts(), processes);
    const started = await startProject(manager, "/project", projectSpec());
    if (!started.success) {
      throw new Error("Expected project to start.");
    }

    processes.handles[0]?.write({
      observedAt: 1,
      stream: "stderr",
      text: "database connection failed",
    });
    processes.handles[0]?.exit(7);
    processes.handles[1]?.exit(0);

    const completion = await started.output.completed;
    expect(completion.kind).toBe("natural");
    if (completion.kind === "natural" && !completion.result.success) {
      expect(completion.result.diagnostics[0]).toMatchObject({
        code: "SYD4006",
        notes: [expect.stringContaining("database connection failed")],
      });
    }
  });

  test("keeps stopped resource logs available without keeping the project active", async () => {
    const processes = new FakeProcesses();
    const manager = createManager(new FakePorts(), processes);
    const started = await startProject(manager, "/project", projectSpec());
    if (!started.success) {
      throw new Error("Expected project to start.");
    }
    processes.handles[0]?.write({ observedAt: 1, stream: "stdout", text: "listening" });

    expect((await started.output.stop()).success).toBeTrue();

    expect(manager.listActiveProjects().projects).toEqual([]);
    const recent = manager.listRecentProjects();
    expect(recent.projects).toMatchObject([{ id: started.output.id }]);
    expect(Object.isFrozen(recent.projects[0])).toBeTrue();
    expect(Object.isFrozen(recent.projects[0]?.services)).toBeTrue();
    expect(manager.getResourceLogs(started.output.id, "api")?.snapshot()).toMatchObject({
      entries: [{ sequence: 1, text: "listening" }],
      status: "complete",
    });
  });

  test("publishes output capture failures through the feed and project completion", async () => {
    const processes = new FakeProcesses();
    const manager = createManager(new FakePorts(), processes);
    const started = await startProject(manager, "/project", projectSpec());
    if (!started.success) {
      throw new Error("Expected project to start.");
    }
    const captureFailure = failure(
      createDiagnostic({ code: "SYD4008", message: "Expected output capture failure." }),
    );

    processes.handles[0]?.exit(0, captureFailure);
    processes.handles[1]?.exit(0);

    const completion = await started.output.completed;
    expect(completion).toMatchObject({
      kind: "natural",
      result: { diagnostics: [{ code: "SYD4008" }], success: false },
    });
    expect(manager.getResourceLogs(started.output.id, "api")?.snapshot()).toMatchObject({
      completion: { diagnostics: [{ code: "SYD4008" }], success: false },
      status: "failed",
    });
  });

  test("bounds recent projects and makes eviction observable", async () => {
    const ports = new FakePorts();
    const processes = new FakeProcesses();
    const manager = new ProjectManager({
      ports,
      processes,
      recentProjectLimit: 1,
    });
    const first = await startProject(manager, "/first", projectSpec());
    if (!first.success) {
      throw new Error("Expected first project to start.");
    }
    const firstLogs = manager.getResourceLogs(first.output.id, "api");
    expect((await first.output.stop()).success).toBeTrue();

    const second = await startProject(manager, "/second", projectSpec());
    if (!second.success) {
      throw new Error("Expected second project to start.");
    }
    expect((await second.output.stop()).success).toBeTrue();

    expect(manager.listRecentProjects().projects.map(({ id: projectId }) => projectId)).toEqual([
      second.output.id,
    ]);
    expect(manager.getResourceLogs(first.output.id, "api")).toBeUndefined();
    expect(firstLogs?.snapshot().status).toBe("removed");
  });
});

describe("project catalog", () => {
  test("persists canonical roots and refreshes definitions without re-adding", async () => {
    const store = new FakeProjectStore();
    const observer = new FakeDefinitionObserver();
    let definition: ProjectDefinitionLoad = { kind: "valid", spec: projectSpec() };
    const opened = await ProjectCatalog.open({
      canonicalize: async () => success("/canonical/project"),
      createId: () => "project-one",
      diagnostics: { report() {} },
      loadDefinition: async () => definition,
      observer,
      store,
    });
    if (!opened.success) {
      throw new Error("Expected the catalog to open.");
    }
    const catalog = opened.output;

    const added = await catalog.add("/input/project");
    expect(added.success).toBeTrue();
    expect(store.records).toEqual([{ id: "project-one", root: "/canonical/project" }]);
    expect(catalog.list()[0]?.definition.kind).toBe("valid");

    definition = {
      diagnostics: [createDiagnostic({ code: "SYD4996", message: "Expected invalid definition." })],
      kind: "invalid",
    };
    observer.change("/canonical/project");
    await tick();
    await tick();

    expect(catalog.list()[0]).toMatchObject({
      definition: {
        diagnostics: [{ code: "SYD4996" }],
        kind: "invalid",
        lastValidSpec: { name: "demo" },
      },
    });
    expect((await catalog.add("/input/project")).success).toBeTrue();
    expect(store.saveCount).toBe(1);

    expect((await catalog.remove("project-one")).success).toBeTrue();
    expect(store.records).toEqual([]);
    expect(observer.closedRoots).toEqual(["/canonical/project"]);
    await catalog.close();

    const closed = await catalog.add("/input/project");
    expect(closed.success).toBeFalse();
    if (!closed.success) {
      expect(closed.diagnostics[0].code).toBe("SYD4105");
    }
    expect(store.saveCount).toBe(2);
  });

  test("keeps one durable project while definition and runtime state change", async () => {
    const store = new FakeProjectStore();
    const observer = new FakeDefinitionObserver();
    let definition: ProjectDefinitionLoad = {
      kind: "valid",
      spec: projectSpecWithManualWeb(),
    };
    const opened = await ProjectCatalog.open({
      canonicalize: async () => success("/canonical/project"),
      createId: () => "project-one",
      diagnostics: { report() {} },
      loadDefinition: async () => definition,
      observer,
      store,
    });
    if (!opened.success) {
      throw new Error("Expected the catalog to open.");
    }
    const manager = createManager(new FakePorts(), new FakeProcesses());
    const projects = new ProjectOrchestrator(opened.output, manager);

    const missing = await projects.start({
      environment: {},
      environmentNamesCaseInsensitive: true,
      root: "/canonical/project",
    });
    expect(missing.success).toBeFalse();
    if (!missing.success) {
      expect(missing.diagnostics[0].code).toBe("SYD4100");
    }

    const added = await projects.add("/input/project");
    expect(added).toMatchObject({
      output: {
        id: "project-one",
        services: [
          { name: "api", startup: "automatic", state: "stopped" },
          { name: "web", startup: "manual", state: "stopped" },
        ],
        state: "stopped",
      },
      success: true,
    });

    const started = await projects.start({
      environment: {},
      environmentNamesCaseInsensitive: true,
      root: "/canonical/project",
    });
    if (!started.success) {
      throw new Error("Expected the durable project to start.");
    }
    expect(started.output.id).toBe("project-one");
    expect(projects.list()[0]).toMatchObject({
      id: "project-one",
      services: [
        { name: "api", startup: "automatic", state: "running" },
        { name: "web", startup: "manual", state: "stopped" },
      ],
      state: "running",
    });

    definition = { kind: "valid", spec: projectSpecWithWorker() };
    observer.change("/canonical/project");
    await tick();
    await tick();

    expect(projects.list()[0]).toMatchObject({
      id: "project-one",
      restartRequired: true,
      services: [
        { name: "api", startup: "automatic", state: "running" },
        { name: "web", startup: "automatic", state: "stopped" },
        { name: "worker", startup: "automatic", state: "stopped" },
      ],
    });
    const refused = await projects.remove("project-one");
    expect(refused.success).toBeFalse();
    if (!refused.success) {
      expect(refused.diagnostics[0].code).toBe("SYD4102");
    }

    const stopped = await projects.stop("project-one");
    expect(stopped).toMatchObject({
      output: { id: "project-one", state: "stopped" },
      success: true,
    });
    expect((await projects.stop("project-one")).success).toBeTrue();
    expect(await started.output.completed).toEqual({ kind: "stopped" });
    expect((await projects.remove("project-one")).success).toBeTrue();
    await opened.output.close();
  });
});

function createManager(ports: PortAllocator, processes: ProcessHost): ProjectManager {
  return new ProjectManager({
    ports,
    processes,
  });
}

class FakeProjectStore implements ProjectStore {
  records: readonly ProjectRecord[] = [];
  saveCount = 0;

  async load() {
    return success(this.records);
  }

  async save(records: readonly ProjectRecord[]) {
    this.saveCount += 1;
    this.records = records;
    return success(undefined);
  }
}

class FakeDefinitionObserver {
  readonly callbacks = new Map<string, () => void>();
  readonly closedRoots: string[] = [];

  observe(root: string, onChange: () => void) {
    this.callbacks.set(root, onChange);
    const observation: ProjectDefinitionObservation = {
      close: () => {
        this.closedRoots.push(root);
        this.callbacks.delete(root);
      },
    };
    return success(observation);
  }

  change(root: string): void {
    this.callbacks.get(root)?.();
  }
}

function startProject(
  manager: ProjectManager,
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
        startup: "automatic",
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
        startup: "automatic",
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
        startup: "automatic",
      },
    },
  });
  if (!result.success) {
    throw new Error("Test project specification is invalid.");
  }
  return result.output;
}

function projectSpecWithManualWeb(): ProjectSpec {
  const current = projectSpec();
  const web = current.resources.web;
  if (!web) {
    throw new Error("Expected the web service specification.");
  }
  const result = createProjectSpec({
    name: current.name,
    resources: {
      ...current.resources,
      web: { ...web, startup: "manual" },
    },
  });
  if (!result.success) {
    throw new Error("Test project specification is invalid.");
  }
  return result.output;
}

function projectSpecWithOnlyManualServices(): ProjectSpec {
  const current = projectSpec();
  const result = createProjectSpec({
    name: current.name,
    resources: Object.fromEntries(
      Object.entries(current.resources).map(([name, resource]) => [
        name,
        { ...resource, startup: "manual" },
      ]),
    ),
  });
  if (!result.success) {
    throw new Error("Test project specification is invalid.");
  }
  return result.output;
}

class FakePorts implements PortAllocator {
  readonly leases: FakeLease[] = [];
  readonly preferredPorts: (number | undefined)[] = [];
  #nextPort = 5000;

  constructor(private readonly afterReserve?: () => void) {}

  async reserve(preferredPort: number | undefined) {
    this.preferredPorts.push(preferredPort);
    const lease = new FakeLease(preferredPort ?? this.#nextPort++);
    this.leases.push(lease);
    this.afterReserve?.();
    return success<PortLease>(lease);
  }
}

class FakeLease implements PortLease {
  readonly host = "127.0.0.1";
  disposeFailures = 0;
  disposed = 0;
  released = 0;

  constructor(readonly port: number) {}

  async dispose() {
    if (this.disposeFailures > 0) {
      this.disposeFailures -= 1;
      return failure(createDiagnostic({ code: "SYD4997", message: "Expected dispose failure." }));
    }
    this.disposed = 1;
    return success(undefined);
  }

  async releaseReservation() {
    this.released = 1;
    return success(undefined);
  }
}

class FakeProcesses implements ProcessHost {
  readonly handles: FakeHandle[] = [];
  readonly starts: ProcessStart[] = [];

  constructor(
    private failAt = -1,
    private readonly afterStart?: () => void,
  ) {}

  async start(input: ProcessStart) {
    const index = this.starts.length;
    this.starts.push(input);
    if (index === this.failAt) {
      this.failAt = -1;
      return failure(createDiagnostic({ code: "SYD4999", message: "Expected start failure." }));
    }

    const handle = new FakeHandle(index + 1, input);
    this.handles.push(handle);
    this.afterStart?.();
    return success<ProcessHandle>(handle);
  }
}

class FakeHandle implements ProcessHandle {
  readonly exited: Promise<ProcessExit>;
  readonly leaderExited: Promise<number>;
  stopGate: Promise<void> | undefined;
  stopFailures = 0;
  stopExitCode = 0;
  stopCount = 0;
  #exit!: (exit: ProcessExit) => void;
  #leaderExit!: (exitCode: number) => void;

  constructor(
    readonly pid: number,
    private readonly input: ProcessStart,
  ) {
    this.exited = new Promise((resolve) => {
      this.#exit = resolve;
    });
    this.leaderExited = new Promise((resolve) => {
      this.#leaderExit = resolve;
    });
  }

  exit(code: number, logCapture: Result<void> = success(undefined)): void {
    this.exitLeader(code);
    this.settle(code, logCapture);
  }

  exitLeader(code: number): void {
    this.#leaderExit(code);
  }

  settle(code: number, logCapture: Result<void> = success(undefined)): void {
    this.#exit({ cleanup: success(undefined), exitCode: code, logCapture });
  }

  write(...entries: ProcessLogLine[]): void {
    this.input.logs.write(entries);
  }

  async stop() {
    this.stopCount += 1;
    await this.stopGate;
    if (this.stopFailures > 0) {
      this.stopFailures -= 1;
      return failure(createDiagnostic({ code: "SYD4998", message: "Expected stop failure." }));
    }
    this.exit(this.stopExitCode);
    return success(undefined);
  }
}

async function tick(): Promise<void> {
  await Bun.sleep(0);
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
