import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Cause, Context, Effect, Exit, Layer } from "effect";

import { readPort } from "../apps/daemon/src/config.ts";
import { Daemon, makeDaemonLayer } from "../apps/daemon/src/daemon.ts";
import { acquireDaemonLock, readLocator } from "../apps/daemon/src/locator.ts";
import { runManagedDaemon } from "../apps/daemon/src/managed.ts";
import { BunPortAllocator } from "../apps/daemon/src/ports.ts";
import { BunProcessHost } from "../apps/daemon/src/processes.ts";
import { startControlServer, type Projects } from "../apps/daemon/src/server.ts";
import {
  ProjectManager,
  type PortAllocator,
  type ProcessExit,
  type ProcessHandle,
  type ProcessHost,
  type ProcessLogLine,
  type ProcessStart,
} from "../packages/control-plane/src/index.ts";
import { createDiagnostic, failure, success } from "../packages/diagnostics/src/index.ts";
import {
  createProjectSpec,
  createStartProjectMessage,
  createStopProjectMessage,
  parseDaemonServerMessage,
  type Project,
} from "../packages/protocol/src/index.ts";

describe("daemon configuration", () => {
  test("uses the default port when PORT is absent", () => {
    expect(readPort(undefined)).toEqual({ output: 3000, success: true });
  });

  test("accepts an explicit TCP port", () => {
    expect(readPort("4400")).toEqual({ output: 4400, success: true });
  });

  test.each(["", "0", "65536", "3e3", "3000.5", "port"])(
    "rejects invalid PORT value %p",
    (value) => {
      const result = readPort(value);

      expect(result.success).toBeFalse();
      if (!result.success) {
        expect(result.diagnostics[0].code).toBe("SYD3000");
        expect(result.diagnostics[0].help).toBe("Set PORT to a whole number from 1 to 65535.");
      }
    },
  );
});

describe("daemon lifecycle", () => {
  test("starts the catalog-backed server and releases its port", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "stackyard-daemon-"));
    let cleanupFailure: unknown;
    let port = 0;
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(
              makeDaemonLayer(
                {
                  dataDirectory,
                  diagnostics: { report() {} },
                  evaluatorEntrypoint: resolve(import.meta.dir, "../apps/cli/src/main.ts"),
                  instanceId: "catalog-daemon",
                  port: 0,
                },
                (diagnostic) => {
                  cleanupFailure = diagnostic;
                },
              ),
            );
            const daemon = Context.get(context, Daemon);
            port = daemon.port;
            const projects = yield* Effect.promise(() =>
              fetch(new URL("/api/v1/projects", daemon.url)),
            );
            expect(projects.status).toBe(200);
            expect(yield* Effect.promise(() => projects.json())).toEqual({
              projects: [],
              schemaVersion: 1,
            });
          }),
        ),
      );

      expect(cleanupFailure).toBeUndefined();
      const rebound = startTestServer(port);
      expect(rebound.success).toBeTrue();
      if (rebound.success) {
        await rebound.output.stop(true);
      }
    } finally {
      await rm(dataDirectory, { force: true, recursive: true });
    }
  });

  test("interrupts the managed daemon and releases its locator and port", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "stackyard-managed-daemon-"));
    const runtimeDirectory = join(temporaryRoot, "runtime");
    const controller = new AbortController();
    const reported: unknown[] = [];
    let port = 0;

    try {
      const exit = await Effect.runPromiseExit(
        runManagedDaemon({
          dashboardWebDirectory: resolve(import.meta.dir, "../apps/dashboard-web/dist"),
          dataDirectory: join(temporaryRoot, "data"),
          diagnostics: { report: (diagnostic) => reported.push(diagnostic) },
          evaluatorEntrypoint: resolve(import.meta.dir, "../apps/cli/src/main.ts"),
          onStarted(locator) {
            port = locator.port;
            controller.abort();
          },
          runtimeDirectory,
        }),
        { signal: controller.signal },
      );

      expect(Exit.isFailure(exit)).toBeTrue();
      if (Exit.isFailure(exit)) {
        expect(Cause.hasInterruptsOnly(exit.cause)).toBeTrue();
      }
      expect(reported).toEqual([]);
      expect(await readLocator(runtimeDirectory)).toBeUndefined();
      const lock = await acquireDaemonLock(runtimeDirectory, "after-interruption");
      expect(lock.success).toBeTrue();
      if (lock.success) {
        expect(lock.output).toBeDefined();
        await lock.output?.release();
      }
      const rebound = startTestServer(port);
      expect(rebound.success).toBeTrue();
      if (rebound.success) {
        await rebound.output.stop(true);
      }
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });
});

describe("HTTP server", () => {
  test("reports an occupied port without throwing", async () => {
    const first = startTestServer(0);
    if (!first.success) {
      throw new Error("The test server could not start.");
    }

    try {
      const port = first.output.port;
      if (port === undefined) {
        throw new Error("The test server did not expose its assigned port.");
      }

      const second = startTestServer(port);

      expect(second.success).toBeFalse();
      if (!second.success) {
        expect(second.diagnostics[0].code).toBe("SYD3001");
        expect(second.diagnostics[0].help).toContain("local networking");
      }
    } finally {
      await first.output.stop(true);
    }
  });

  test("serves health and returns secure not-found responses", async () => {
    const result = startTestServer(0);

    expect(result.success).toBeTrue();
    if (!result.success) {
      throw new Error("The test server could not start.");
    }

    const server = result.output;
    try {
      expect(server.hostname).toBe("127.0.0.1");
      expect(server.port).toBeGreaterThan(0);

      const health = await fetch(new URL("/health", server.url));
      expect(health.status).toBe(200);
      expect(health.headers.get("cache-control")).toBe("no-store");
      expect(await health.json()).toEqual({
        instanceId: "test-daemon",
        protocolVersion: 1,
        status: "ok",
      });

      const projects = await fetch(new URL("/api/v1/projects", server.url));
      expect(projects.status).toBe(200);
      expect(projects.headers.get("cache-control")).toBe("no-store");
      expect(await projects.json()).toEqual({ projects: [], schemaVersion: 1 });

      const root = await fetch(server.url);
      expect(root.status).toBe(404);
      expect(root.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(await root.text()).toBe("Not found.");

      const missing = await fetch(new URL("/missing", server.url));
      expect(missing.status).toBe(404);
      expect(missing.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(await missing.text()).toBe("Not found.");
    } finally {
      await server.stop(true);
    }
  });

  test("authenticates control sockets and rejects malformed messages", async () => {
    const result = startTestServer(0);
    if (!result.success) {
      throw new Error("The test server could not start.");
    }

    const server = result.output;
    let socket: WebSocket | undefined;
    try {
      const unauthorized = await fetch(new URL("/api/v1/control", server.url));
      expect(unauthorized.status).toBe(401);

      socket = await connectControl(server.url, "test-token");
      const response = nextMessage(socket);
      socket.send("{");
      const parsed = parseDaemonServerMessage(JSON.parse(await response));

      expect(parsed.success).toBeTrue();
      if (parsed.success) {
        expect(parsed.output.kind).toBe("failed");
      }
    } finally {
      socket?.close();
      await server.stop(true);
    }
  });

  test("accepts authenticated shutdown intent without exposing it publicly", async () => {
    let shutdownRequests = 0;
    const result = startTestServer(0, undefined, undefined, undefined, () => {
      shutdownRequests += 1;
    });
    if (!result.success) {
      throw new Error("The test server could not start.");
    }

    const server = result.output;
    try {
      const unauthorized = await fetch(new URL("/api/v1/shutdown", server.url), {
        method: "POST",
      });
      expect(unauthorized.status).toBe(401);

      const wrongMethod = await fetch(new URL("/api/v1/shutdown", server.url), {
        headers: { authorization: "Bearer test-token" },
      });
      expect(wrongMethod.status).toBe(405);

      const accepted = await fetch(new URL("/api/v1/shutdown", server.url), {
        headers: { authorization: "Bearer test-token" },
        method: "POST",
      });
      expect(accepted.status).toBe(202);
      expect(shutdownRequests).toBe(1);
    } finally {
      await server.stop(true);
    }
  });

  test("lists and mutates durable projects through one endpoint", async () => {
    const project: Project = {
      id: "project-one",
      name: "demo",
      restartRequired: false,
      root: resolve(import.meta.dir, "../project"),
      services: [{ endpoints: [], name: "api", state: "stopped" }],
      state: "stopped",
    };
    const projects: Projects = {
      list: () => [project],
      async add(path) {
        expect(path).toBe(project.root);
        return success(project);
      },
      async remove(target) {
        expect(target).toBe("project-one");
        return success(project);
      },
      async start() {
        throw new Error("Unexpected project start request.");
      },
      async stop(target) {
        expect(target).toBe("project-one");
        return success(project);
      },
    };
    const result = startTestServer(0, undefined, undefined, projects);
    if (!result.success) {
      throw new Error("The test server could not start.");
    }

    const server = result.output;
    try {
      const listed = await fetch(new URL("/api/v1/projects", server.url));
      expect(listed.status).toBe(200);
      expect(await listed.json()).toEqual({ projects: [project], schemaVersion: 1 });

      const unauthorizedMutation = await fetch(new URL("/api/v1/projects", server.url), {
        body: JSON.stringify({ path: project.root }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(unauthorizedMutation.status).toBe(401);

      const added = await fetch(new URL("/api/v1/projects", server.url), {
        body: JSON.stringify({ path: project.root }),
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        method: "POST",
      });
      expect(added.status).toBe(200);
      expect(await added.json()).toEqual(project);

      const removed = await fetch(new URL("/api/v1/projects", server.url), {
        body: JSON.stringify({ target: "project-one" }),
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        method: "DELETE",
      });
      expect(removed.status).toBe(200);
      expect(await removed.json()).toEqual(project);

      const stopped = await fetch(new URL("/api/v1/projects/stop", server.url), {
        body: JSON.stringify({ target: "project-one" }),
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        method: "POST",
      });
      expect(stopped.status).toBe(200);
      expect(await stopped.json()).toEqual(project);

      const malformed = await fetch(new URL("/api/v1/projects", server.url), {
        body: "{}",
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        method: "POST",
      });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toMatchObject({ diagnostics: [{ code: "SYD3016" }] });
    } finally {
      await server.stop(true);
    }
  });

  test("cleans up a project when its control lease disconnects during startup", async () => {
    const processes = new BlockingProcesses();
    const manager = new ProjectManager({
      ports: new UnusedPorts(),
      processes,
    });
    const result = startTestServer(0, manager);
    if (!result.success) {
      throw new Error("The test server could not start.");
    }

    const server = result.output;
    const socket = await connectControl(server.url, "test-token");
    try {
      socket.send(JSON.stringify(createStartProjectMessage(resolve(import.meta.dir, ".."), {})));
      await processes.started;
      socket.terminate();
      processes.continue();

      await waitFor(() =>
        processes.handle.stopCount === 1 && manager.listActiveProjects().projects.length === 0
          ? true
          : undefined,
      );
    } finally {
      processes.continue();
      await server.stop(true);
    }
  });

  test("cancels startup as soon as a stop message arrives", async () => {
    const processes = new BlockingProcesses();
    processes.handle.stopFailures = 1;
    let cancellation: AbortSignal | undefined;
    const manager = new ProjectManager({
      ports: new UnusedPorts(),
      processes,
    });
    const result = startTestServer(0, manager, (serverSocket) => {
      cancellation = serverSocket.data.cancellation.signal;
    });
    if (!result.success) {
      throw new Error("The test server could not start.");
    }

    const server = result.output;
    const socket = await connectControl(server.url, "test-token");
    try {
      socket.send(JSON.stringify(createStartProjectMessage(resolve(import.meta.dir, ".."), {})));
      await processes.started;
      const response = nextMessage(socket);
      socket.send(JSON.stringify(createStopProjectMessage()));
      await waitFor(() => (cancellation?.aborted ? true : undefined));
      processes.continue();

      const parsed = parseDaemonServerMessage(JSON.parse(await response));
      expect(parsed.success).toBeTrue();
      if (parsed.success) {
        expect(parsed.output.kind).toBe("stopped");
      }
      expect(processes.handle.stopCount).toBe(2);
      expect(manager.listActiveProjects().projects).toEqual([]);
    } finally {
      processes.continue();
      socket.terminate();
      await server.stop(true);
    }
  });

  test("notifies an attached run when another client stops its project", async () => {
    const manager = new ProjectManager({
      ports: new UnusedPorts(),
      processes: new ImmediateProcesses(),
    });
    const result = startTestServer(0, manager);
    if (!result.success) {
      throw new Error("The test server could not start.");
    }

    const server = result.output;
    const socket = await connectControl(server.url, "test-token");
    try {
      const startedMessage = nextMessage(socket);
      socket.send(JSON.stringify(createStartProjectMessage(resolve(import.meta.dir, ".."), {})));
      const started = parseDaemonServerMessage(JSON.parse(await startedMessage));
      expect(started).toMatchObject({ output: { kind: "started" }, success: true });

      const stoppedMessage = nextMessage(socket);
      const response = await fetch(new URL("/api/v1/projects/stop", server.url), {
        body: JSON.stringify({ target: "project-one" }),
        headers: {
          authorization: "Bearer test-token",
          "content-type": "application/json",
        },
        method: "POST",
      });
      expect(response.status).toBe(200);
      const stopped = parseDaemonServerMessage(JSON.parse(await stoppedMessage));
      expect(stopped).toMatchObject({ output: { kind: "stopped" }, success: true });
      expect(manager.listActiveProjects().projects).toEqual([]);
    } finally {
      socket.terminate();
      await server.stop(true);
    }
  });

  test("reports retained startup failure before cleanup supervision completes", async () => {
    const cleanupGate = deferred();
    const processes = new FailingStartProcesses();
    processes.handle.stopFailures = 1;
    processes.handle.stopGate = cleanupGate.promise;
    const manager = new ProjectManager({
      ports: new UnusedPorts(),
      processes,
    });
    const result = startTestServer(
      0,
      manager,
      undefined,
      testProjects(manager, twoResourceProjectSpec()),
    );
    if (!result.success) {
      throw new Error("The test server could not start.");
    }

    const server = result.output;
    const socket = await connectControl(server.url, "test-token");
    try {
      const response = nextMessage(socket);
      socket.send(JSON.stringify(createStartProjectMessage(resolve(import.meta.dir, ".."), {})));

      const parsed = parseDaemonServerMessage(JSON.parse(await response));
      expect(parsed.success).toBeTrue();
      if (!parsed.success || parsed.output.kind !== "failed") {
        throw new Error("Expected a retained startup failure.");
      }
      expect(parsed.output.report.diagnostics.map(({ code }) => code)).toEqual([
        "SYD4998",
        "SYD4999",
      ]);
      expect(manager.listActiveProjects().projects).toHaveLength(1);

      cleanupGate.resolve();
      await waitFor(() => (manager.listActiveProjects().projects.length === 0 ? true : undefined));
    } finally {
      cleanupGate.resolve();
      socket.terminate();
      await server.stop(true);
    }
  });
});

describe("service port allocation", () => {
  test("falls back from occupied preferences and releases reservations", async () => {
    const occupied = startTestServer(0);
    if (!occupied.success || occupied.output.port === undefined) {
      throw new Error("The occupied-port fixture could not start.");
    }

    const allocator = new BunPortAllocator();
    try {
      const first = await allocator.reserve(occupied.output.port);
      const second = await allocator.reserve(undefined);
      if (!first.success || !second.success) {
        throw new Error("The allocator could not reserve fixture ports.");
      }

      expect(first.output.port).not.toBe(occupied.output.port);
      expect(second.output.port).not.toBe(first.output.port);

      const port = first.output.port;
      expect((await first.output.releaseReservation()).success).toBeTrue();
      const rebound = startTestServer(port);
      expect(rebound.success).toBeTrue();
      if (rebound.success) {
        await rebound.output.stop(true);
      }

      expect((await first.output.dispose()).success).toBeTrue();
      expect((await first.output.dispose()).success).toBeTrue();
      expect((await second.output.dispose()).success).toBeTrue();

      const reused = await allocator.reserve(port);
      expect(reused.success).toBeTrue();
      if (reused.success) {
        expect(reused.output.port).toBe(port);
        await reused.output.dispose();
      }
    } finally {
      await occupied.output.stop(true);
    }
  });
});

describe("service process lifecycle", () => {
  test("stops descendants with their managed process", async () => {
    const allocator = new BunPortAllocator();
    const reserved = await allocator.reserve(undefined);
    if (!reserved.success) {
      throw new Error("The child-process port could not be reserved.");
    }
    const lease = reserved.output;
    let handle: ProcessHandle | undefined;

    try {
      expect((await lease.releaseReservation()).success).toBeTrue();
      const started = await new BunProcessHost({ report() {} }).start({
        args: [resolve(import.meta.dir, "fixtures/process-tree.ts")],
        env: { ...stringEnvironment(process.env), CHILD_PORT: String(lease.port) },
        executable: process.execPath,
        logs: discardLogs,
        projectRoot: resolve(import.meta.dir, ".."),
        workingDirectory: ".",
      });
      if (!started.success) {
        throw new Error("The process-tree fixture could not start.");
      }
      handle = started.output;

      await waitFor(async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${lease.port}`);
          return response.ok ? true : undefined;
        } catch {
          return undefined;
        }
      });

      expect((await handle.stop()).success).toBeTrue();
      await waitFor(async () => {
        try {
          await fetch(`http://127.0.0.1:${lease.port}`);
          return undefined;
        } catch {
          return true;
        }
      });
    } finally {
      if (handle) {
        await handle.stop();
      }
      await lease.dispose();
    }
  }, 10_000);

  test("reaps descendants when their leader exits naturally", async () => {
    const allocator = new BunPortAllocator();
    const reserved = await allocator.reserve(undefined);
    if (!reserved.success) {
      throw new Error("The child-process port could not be reserved.");
    }
    const lease = reserved.output;
    let childPid: number | undefined;
    let handle: ProcessHandle | undefined;
    const logs: ProcessLogLine[] = [];

    try {
      expect((await lease.releaseReservation()).success).toBeTrue();
      const started = await new BunProcessHost({ report() {} }).start({
        args: [resolve(import.meta.dir, "fixtures/process-tree.ts"), "orphan"],
        env: { ...stringEnvironment(process.env), CHILD_PORT: String(lease.port) },
        executable: process.execPath,
        logs: { write: (entries) => logs.push(...entries) },
        projectRoot: resolve(import.meta.dir, ".."),
        workingDirectory: ".",
      });
      if (!started.success) {
        throw new Error("The process-tree fixture could not start.");
      }
      handle = started.output;

      const exited = await handle.exited;
      expect(exited.cleanup.success).toBeTrue();
      expect(exited.exitCode).toBe(0);
      if (!exited.logCapture.success) {
        throw new Error("The child process identifier could not be captured.");
      }
      childPid = Number(
        logs
          .filter(({ stream }) => stream === "stdout")
          .map(({ text }) => text)
          .join("\n")
          .trim(),
      );
      expect(Number.isSafeInteger(childPid)).toBeTrue();
      expect(isProcessAlive(childPid)).toBeFalse();
      expect(fetch(`http://127.0.0.1:${lease.port}`)).rejects.toBeDefined();
    } finally {
      if (handle) {
        await handle.stop();
      }
      if (childPid && isProcessAlive(childPid)) {
        await forceStopProcess(childPid);
      }
      await lease.dispose();
    }
  }, 10_000);

  test("reaps a service tree when its owning process is killed", async () => {
    const allocator = new BunPortAllocator();
    const reserved = await allocator.reserve(undefined);
    if (!reserved.success) {
      throw new Error("The child-process port could not be reserved.");
    }
    const lease = reserved.output;
    let owner: Bun.Subprocess<"ignore", "pipe", "ignore"> | undefined;
    let servicePid: number | undefined;

    try {
      expect((await lease.releaseReservation()).success).toBeTrue();
      owner = Bun.spawn({
        cmd: [process.execPath, resolve(import.meta.dir, "fixtures/process-owner.ts")],
        env: { ...stringEnvironment(process.env), CHILD_PORT: String(lease.port) },
        stderr: "ignore",
        stdin: "ignore",
        stdout: "pipe",
        windowsHide: true,
      });
      const runningServicePid = await readProcessIdentifier(owner.stdout);
      servicePid = runningServicePid;
      await waitFor(async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${lease.port}`);
          return response.ok ? true : undefined;
        } catch {
          return undefined;
        }
      });

      owner.kill("SIGKILL");
      await owner.exited;
      await waitFor(async () => {
        try {
          await fetch(`http://127.0.0.1:${lease.port}`);
          return undefined;
        } catch {
          return true;
        }
      });
      await waitFor(() => (isProcessAlive(runningServicePid) ? undefined : true));
    } finally {
      if (owner?.exitCode === null) {
        owner.kill("SIGKILL");
        await owner.exited;
      }
      if (servicePid && isProcessAlive(servicePid)) {
        await forceStopProcessTree(servicePid);
      }
      await lease.dispose();
    }
  }, 10_000);
});

function startTestServer(
  port: number,
  manager = new ProjectManager({
    ports: new BunPortAllocator(),
    processes: new BunProcessHost({ report() {} }),
  }),
  onOpen: Parameters<typeof startControlServer>[0]["onOpen"] = () => {},
  projects: Projects = testProjects(manager),
  requestShutdown?: () => void,
) {
  return startControlServer({
    diagnostics: { report() {} },
    instanceId: "test-daemon",
    isShuttingDown: () => false,
    manager,
    onClose() {},
    onOpen,
    port,
    projects,
    requestShutdown: requestShutdown ?? (() => {}),
    token: "test-token",
  });
}

function testProjects(manager: ProjectManager, spec = projectSpec()): Projects {
  return {
    list(): readonly Project[] {
      return [];
    },
    async add() {
      throw new Error("Unexpected project add request.");
    },
    async remove() {
      throw new Error("Unexpected project remove request.");
    },
    start(input) {
      return manager.start({
        ...input,
        id: "project-one",
        revision: 1,
        spec,
      });
    },
    async stop() {
      const stopped = await manager.stop("project-one");
      if (!stopped.success) {
        return stopped;
      }
      return success<Project>({
        id: "project-one",
        name: spec.name,
        restartRequired: false,
        root: resolve(import.meta.dir, ".."),
        services: Object.keys(spec.resources).map((name) => ({
          endpoints: [],
          name,
          state: "stopped",
        })),
        state: "stopped",
      });
    },
  };
}

function connectControl(serverUrl: URL, token: string): Promise<WebSocket> {
  return new Promise((resolveConnection, rejectConnection) => {
    const socket = new WebSocket(new URL("/api/v1/control", serverUrl), {
      headers: { authorization: `Bearer ${token}` },
    });
    socket.addEventListener("open", () => resolveConnection(socket), { once: true });
    socket.addEventListener("error", () => rejectConnection(new Error("WebSocket failed.")), {
      once: true,
    });
  });
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolveMessage) => {
    socket.addEventListener("message", (event) => resolveMessage(String(event.data)), {
      once: true,
    });
  });
}

function projectSpec() {
  const created = createProjectSpec({
    name: "disconnect-fixture",
    resources: {
      service: {
        command: { args: [], executable: "fixture" },
        cwd: ".",
        endpoints: {},
        env: {},
        kind: "process",
      },
    },
  });
  if (!created.success) {
    throw new Error("Test project specification is invalid.");
  }
  return created.output;
}

function twoResourceProjectSpec() {
  const created = createProjectSpec({
    name: "failure-fixture",
    resources: {
      api: {
        command: { args: [], executable: "fixture" },
        cwd: ".",
        endpoints: {},
        env: {},
        kind: "process",
      },
      web: {
        command: { args: [], executable: "fixture" },
        cwd: ".",
        endpoints: {},
        env: {},
        kind: "process",
      },
    },
  });
  if (!created.success) {
    throw new Error("Test project specification is invalid.");
  }
  return created.output;
}

class UnusedPorts implements PortAllocator {
  async reserve(): Promise<never> {
    throw new Error("The fixture does not define endpoints.");
  }
}

class ImmediateProcesses implements ProcessHost {
  readonly handle = new ControlledHandle();

  async start() {
    return success<ProcessHandle>(this.handle);
  }
}

class BlockingProcesses implements ProcessHost {
  readonly handle = new ControlledHandle();
  readonly started: Promise<void>;
  #continue!: () => void;
  #started!: () => void;
  readonly #unblocked: Promise<void>;

  constructor() {
    this.started = new Promise((resolveStarted) => {
      this.#started = resolveStarted;
    });
    this.#unblocked = new Promise((resolveContinue) => {
      this.#continue = resolveContinue;
    });
  }

  continue(): void {
    this.#continue();
  }

  async start(_input: ProcessStart) {
    this.#started();
    await this.#unblocked;
    return success<ProcessHandle>(this.handle);
  }
}

class FailingStartProcesses implements ProcessHost {
  readonly handle = new ControlledHandle();
  #starts = 0;

  async start() {
    this.#starts += 1;
    return this.#starts === 1
      ? success<ProcessHandle>(this.handle)
      : failure(createDiagnostic({ code: "SYD4999", message: "Expected start failure." }));
  }
}

class ControlledHandle implements ProcessHandle {
  readonly exited: Promise<ProcessExit>;
  readonly leaderExited: Promise<number>;
  readonly pid = 1;
  stopFailures = 0;
  stopCount = 0;
  stopGate: Promise<void> | undefined;
  #exit!: (exit: ProcessExit) => void;

  constructor() {
    this.exited = new Promise((resolveExit) => {
      this.#exit = resolveExit;
    });
    this.leaderExited = this.exited.then(({ exitCode }) => exitCode);
  }

  async stop() {
    this.stopCount += 1;
    if (this.stopFailures > 0) {
      this.stopFailures -= 1;
      return failure(createDiagnostic({ code: "SYD4998", message: "Expected stop failure." }));
    }
    await this.stopGate;
    this.#exit({ cleanup: success(undefined), exitCode: 0, logCapture: success(undefined) });
    return success(undefined);
  }
}

const discardLogs = Object.freeze({ write(_entries: readonly ProcessLogLine[]) {} });

async function waitFor<T>(read: () => Promise<T | undefined> | T | undefined): Promise<T> {
  return poll(read, Date.now() + 2_000);
}

async function poll<T>(
  read: () => Promise<T | undefined> | T | undefined,
  deadline: number,
): Promise<T> {
  const value = await read();
  if (value !== undefined) {
    return value;
  }
  if (Date.now() >= deadline) {
    throw new Error("Timed out waiting for daemon state.");
  }
  await Bun.sleep(10);
  return poll(read, deadline);
}

function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function forceStopProcess(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await Bun.spawn({
      cmd: ["taskkill", "/PID", String(pid), "/T", "/F"],
      stderr: "ignore",
      stdin: "ignore",
      stdout: "ignore",
      windowsHide: true,
    }).exited;
    return;
  }
  process.kill(pid, "SIGKILL");
}

async function forceStopProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await forceStopProcess(pid);
    return;
  }
  process.kill(-pid, "SIGKILL");
}

async function readProcessIdentifier(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (!output.includes("\n")) {
    /* oxlint-disable-next-line eslint/no-await-in-loop -- A single stream must be read in order until its first complete line. */
    const chunk = await reader.read();
    if (chunk.done) {
      throw new Error("The process owner exited before publishing its service identifier.");
    }
    output += decoder.decode(chunk.value, { stream: true });
  }
  reader.releaseLock();
  const pid = Number(output.slice(0, output.indexOf("\n")));
  if (!Number.isSafeInteger(pid) || pid < 1) {
    throw new Error("The process owner published an invalid service identifier.");
  }
  return pid;
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let finishDeferred!: () => void;
  const promise = new Promise<void>((finish) => {
    finishDeferred = finish;
  });
  return { promise, resolve: finishDeferred };
}
