import { describe, expect, test } from "bun:test";

import {
  ProjectManager,
  type PortAllocator,
  type PortLease,
  type ProcessExit,
  type ProcessHandle,
  type ProcessHost,
  type ProcessStart,
} from "../packages/control-plane/src/index.ts";
import { createDiagnostic, failure, success } from "../packages/diagnostics/src/index.ts";
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

    const projects = manager.listProjects();
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
    expect(manager.listProjects().projects).toEqual([]);

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

    expect(manager.listProjects().projects).toHaveLength(1);
    expect(started.success).toBeFalse();
    if (!started.success) {
      expect(started.diagnostics.map(({ code }) => code)).toEqual(["SYD4998", "SYD4999"]);
      expect(started.cleanup?.id).toBeString();
      expect((await started.cleanup?.stop())?.success).toBeTrue();
    }
    expect(manager.listProjects().projects).toEqual([]);
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
    expect(manager.listProjects().projects[0]?.services.map(({ state }) => state)).toEqual([
      "stopping",
      "running",
    ]);
    expect(manager.listProjects().projects[0]?.services[0]?.exitCode).toBe(7);
    expect(processes.handles[1]?.stopCount).toBe(0);

    processes.handles[0]?.settle(7);
    await tick();
    expect(manager.listProjects().projects[0]?.services.map(({ state }) => state)).toEqual([
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
    expect(manager.listProjects().projects).toEqual([]);
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
    expect(manager.listProjects().projects[0]?.services.map(({ state }) => state)).toEqual([
      "failed",
      "exited",
    ]);
    expect(ports.leases.every(({ disposed }) => disposed === 0)).toBeTrue();

    const secondStop = await started.output.stop();
    expect(secondStop.success).toBeTrue();
    expect(firstHandle.stopCount).toBe(2);
    expect(ports.leases.every(({ disposed }) => disposed === 1)).toBeTrue();
    expect(manager.listProjects().projects).toEqual([]);
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
    expect(manager.listProjects().projects[0]?.services.map(({ state }) => state)).toEqual([
      "exited",
      "exited",
    ]);
    expect((await started.output.stop()).success).toBeTrue();
  });

  test("rolls back processes when their owner disconnects during startup", async () => {
    const ports = new FakePorts();
    const cancellation = new AbortController();
    const processes = new FakeProcesses(-1, () => cancellation.abort());
    const manager = createManager(ports, processes);

    const started = await manager.start({
      environment: {},
      environmentNamesCaseInsensitive: false,
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
    expect(manager.listProjects().projects).toEqual([]);
  });

  test("stops endpoint allocation promptly when startup is canceled", async () => {
    const cancellation = new AbortController();
    const ports = new FakePorts(() => cancellation.abort());
    const processes = new FakeProcesses();
    const manager = createManager(ports, processes);

    const started = await manager.start({
      environment: {},
      environmentNamesCaseInsensitive: false,
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
    expect(manager.listProjects().projects).toEqual([]);
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
    expect(manager.listProjects().projects).toEqual([]);
  });
});

function createManager(ports: PortAllocator, processes: ProcessHost): ProjectManager {
  let id = 0;
  return new ProjectManager({
    createId: () => `project-${++id}`,
    ports,
    processes,
  });
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

    const handle = new FakeHandle(index + 1);
    this.handles.push(handle);
    this.afterStart?.();
    return success<ProcessHandle>(handle);
  }
}

class FakeHandle implements ProcessHandle {
  readonly exited: Promise<ProcessExit>;
  readonly leaderExited: Promise<number>;
  readonly output = Promise.resolve(success({ stderr: "", stdout: "" }));
  stopGate: Promise<void> | undefined;
  stopFailures = 0;
  stopExitCode = 0;
  stopCount = 0;
  #exit!: (exit: ProcessExit) => void;
  #leaderExit!: (exitCode: number) => void;

  constructor(readonly pid: number) {
    this.exited = new Promise((resolve) => {
      this.#exit = resolve;
    });
    this.leaderExited = new Promise((resolve) => {
      this.#leaderExit = resolve;
    });
  }

  exit(code: number): void {
    this.exitLeader(code);
    this.settle(code);
  }

  exitLeader(code: number): void {
    this.#leaderExit(code);
  }

  settle(code: number): void {
    this.#exit({ cleanup: success(undefined), exitCode: code });
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
