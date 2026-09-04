import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Cause, Deferred, Effect, Exit, Layer, ManagedRuntime } from "effect";

import { readPort } from "../apps/daemon/src/config.ts";
import { Daemon, makeDaemonLayer } from "../apps/daemon/src/daemon.ts";
import { acquireDaemonLock, readLocator as readLocatorEffect } from "../apps/daemon/src/locator.ts";
import { runManagedDaemon } from "../apps/daemon/src/managed.ts";
import { BunPortAllocatorLayer } from "../apps/daemon/src/ports.ts";
import { makeBunProcessHostLayer } from "../apps/daemon/src/processes.ts";
import {
  closeControlServer,
  startControlServer,
  type ControlData,
  type ControlRuntime,
} from "../apps/daemon/src/server.ts";
import {
  makeProjectManagerLayer,
  PortAllocator,
  ProcessHost,
  ProjectManager,
  ProjectOrchestrator,
  type ProcessExit,
  type ProcessHandle,
  type ProcessLogLine,
} from "../packages/control-plane/src/index.ts";
import {
  createDiagnostic,
  failure,
  success,
  type DiagnosticSink,
  type Failure,
} from "../packages/diagnostics/src/index.ts";
import {
  createProjectSpec,
  createStartProjectMessage,
  createStopProjectMessage,
  parseDaemonServerMessage,
  type Project,
  type ProjectSpec,
} from "../packages/protocol/src/index.ts";

const diagnostics: DiagnosticSink = { report() {} };
const discardLogs = Object.freeze({ write(_entries: readonly ProcessLogLine[]) {} });
const disposeTests: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(disposeTests.splice(0).map((dispose) => dispose()));
});

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
        Daemon.use((daemon) =>
          Effect.gen(function* () {
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
        ).pipe(
          Effect.provide(
            makeDaemonLayer(
              {
                dataDirectory,
                diagnostics,
                evaluatorEntrypoint: resolve(import.meta.dir, "../apps/cli/src/main.ts"),
                instanceId: "catalog-daemon",
                port: 0,
              },
              (diagnostic) =>
                Effect.sync(() => {
                  cleanupFailure = diagnostic;
                }),
            ),
          ),
        ),
      );

      expect(cleanupFailure).toBeUndefined();
      const rebound = bindPort(port);
      await rebound.stop(true);
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
      await expectManagedResourcesReleased(runtimeDirectory, port);
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  test("releases managed resources when startup fails after publication", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "stackyard-managed-daemon-"));
    const runtimeDirectory = join(temporaryRoot, "runtime");
    const reported: unknown[] = [];
    let port = 0;

    try {
      const exitCode = await Effect.runPromise(
        runManagedDaemon({
          dashboardWebDirectory: resolve(import.meta.dir, "../apps/dashboard-web/dist"),
          dataDirectory: join(temporaryRoot, "data"),
          diagnostics: { report: (diagnostic) => reported.push(diagnostic) },
          evaluatorEntrypoint: resolve(import.meta.dir, "../apps/cli/src/main.ts"),
          onStarted(locator) {
            port = locator.port;
            throw new Error("Expected startup callback failure.");
          },
          runtimeDirectory,
        }),
      );

      expect(exitCode).toBe(1);
      expect(reported).toMatchObject([
        { code: "SYD3011", message: "The daemon startup callback failed." },
      ]);
      await expectManagedResourcesReleased(runtimeDirectory, port);
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });
});

describe("HTTP server", () => {
  test("reports an occupied port as a typed failure", async () => {
    const first = await startTestServer();
    const occupiedPort = first.server.port;
    if (occupiedPort === undefined) {
      throw new Error("Expected the first test server to expose its port.");
    }
    const second = await tryStartTestServer({ port: occupiedPort });

    expect(second.ok).toBeFalse();
    if (!second.ok) {
      expect(second.error.diagnostics[0].code).toBe("SYD3001");
      expect(second.error.diagnostics[0].help).toContain("local networking");
    }
  });

  test("serves health and returns secure not-found responses", async () => {
    const { server } = await startTestServer();
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
    expect(await projects.json()).toEqual({ projects: [], schemaVersion: 1 });

    const missingResponses = await Promise.all(
      [server.url, new URL("/missing", server.url)].map(async (url) => {
        const response = await fetch(url);
        return {
          contentSecurityPolicy: response.headers.get("content-security-policy"),
          status: response.status,
          text: await response.text(),
        };
      }),
    );
    for (const missing of missingResponses) {
      expect(missing.status).toBe(404);
      expect(missing.contentSecurityPolicy).toContain("default-src 'self'");
      expect(missing.text).toBe("Not found.");
    }
  });

  test("authenticates control sockets and rejects malformed messages", async () => {
    const { server } = await startTestServer();
    const unauthorized = await fetch(new URL("/api/v1/control", server.url));
    expect(unauthorized.status).toBe(401);

    const socket = await connectControl(server.url, "test-token");
    const response = nextMessage(socket);
    socket.send("{");
    const parsed = parseDaemonServerMessage(JSON.parse(await response));
    expect(parsed).toMatchObject({ output: { kind: "failed" }, success: true });
    socket.close();
  });

  test("accepts authenticated shutdown intent without exposing it publicly", async () => {
    let shutdownRequests = 0;
    const { server } = await startTestServer({
      requestShutdown: () => {
        shutdownRequests += 1;
      },
    });

    expect(
      await fetch(new URL("/api/v1/shutdown", server.url), { method: "POST" }).then(
        ({ status }) => status,
      ),
    ).toBe(401);
    expect(
      await fetch(new URL("/api/v1/shutdown", server.url), authorized()).then(
        ({ status }) => status,
      ),
    ).toBe(405);
    expect(
      await fetch(new URL("/api/v1/shutdown", server.url), {
        ...authorized(),
        method: "POST",
      }).then(({ status }) => status),
    ).toBe(202);
    expect(shutdownRequests).toBe(1);
  });

  test("lists and mutates durable projects through one endpoint", async () => {
    const project = stoppedProject("demo", projectSpec());
    const orchestrator = ProjectOrchestrator.of({
      add: (path) => {
        expect(path).toBe(project.root);
        return Effect.succeed(project);
      },
      list: Effect.succeed([project]),
      remove: (target) => {
        expect(target).toBe("project-one");
        return Effect.succeed(project);
      },
      start: () => Effect.die(new Error("Unexpected project start request.")),
      stop: (target) => {
        expect(target).toBe("project-one");
        return Effect.succeed(project);
      },
    });
    const { server } = await startTestServer({ orchestrator });

    const listed = await fetch(new URL("/api/v1/projects", server.url));
    expect(await listed.json()).toEqual({ projects: [project], schemaVersion: 1 });

    const unauthorizedMutation = await fetch(new URL("/api/v1/projects", server.url), {
      body: JSON.stringify({ path: project.root }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(unauthorizedMutation.status).toBe(401);

    const added = await projectRequest(server, "/api/v1/projects", "POST", {
      path: project.root,
    });
    expect(await added.json()).toEqual(project);
    const removed = await projectRequest(server, "/api/v1/projects", "DELETE", {
      target: "project-one",
    });
    expect(await removed.json()).toEqual(project);
    const stopped = await projectRequest(server, "/api/v1/projects/stop", "POST", {
      target: "project-one",
    });
    expect(await stopped.json()).toEqual(project);

    const malformed = await projectRequest(server, "/api/v1/projects", "POST", {});
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ diagnostics: [{ code: "SYD3016" }] });
  });

  test("interrupts project startup when its control lease disconnects", async () => {
    const processes = new BlockingProcesses();
    const { manager, server } = await startTestServer({ processes: processes.service });
    const socket = await connectControl(server.url, "test-token");
    socket.send(JSON.stringify(createStartProjectMessage(resolve(import.meta.dir, ".."), {})));
    await Effect.runPromise(Deferred.await(processes.started));
    socket.terminate();

    await waitFor(async () =>
      processes.interrupted &&
      (await Effect.runPromise(manager.listActiveProjects)).projects.length === 0
        ? true
        : undefined,
    );
  });

  test("cancels project startup as soon as a stop message arrives", async () => {
    const processes = new BlockingProcesses();
    const { manager, server } = await startTestServer({ processes: processes.service });
    const socket = await connectControl(server.url, "test-token");
    socket.send(JSON.stringify(createStartProjectMessage(resolve(import.meta.dir, ".."), {})));
    await Effect.runPromise(Deferred.await(processes.started));
    const response = nextMessage(socket);
    socket.send(JSON.stringify(createStopProjectMessage()));

    const parsed = parseDaemonServerMessage(JSON.parse(await response));
    expect(parsed).toMatchObject({ output: { kind: "stopped" }, success: true });
    expect(processes.interrupted).toBeTrue();
    expect((await Effect.runPromise(manager.listActiveProjects)).projects).toEqual([]);
    socket.terminate();
  });

  test("notifies an attached run when another client stops its project", async () => {
    const processes = new ImmediateProcesses();
    const { manager, server } = await startTestServer({ processes: processes.service });
    const socket = await connectControl(server.url, "test-token");
    const startedMessage = nextMessage(socket);
    socket.send(JSON.stringify(createStartProjectMessage(resolve(import.meta.dir, ".."), {})));
    expect(parseDaemonServerMessage(JSON.parse(await startedMessage))).toMatchObject({
      output: { kind: "started" },
      success: true,
    });

    const stoppedMessage = nextMessage(socket);
    const response = await projectRequest(server, "/api/v1/projects/stop", "POST", {
      target: "project-one",
    });
    expect(response.status).toBe(200);
    expect(parseDaemonServerMessage(JSON.parse(await stoppedMessage))).toMatchObject({
      output: { kind: "stopped" },
      success: true,
    });
    expect((await Effect.runPromise(manager.listActiveProjects)).projects).toEqual([]);
    socket.terminate();
  });

  test("reports retained startup failure before supervised cleanup completes", async () => {
    const cleanupGate = Deferred.makeUnsafe<void>();
    const processes = new FailingStartProcesses(cleanupGate);
    const { manager, server } = await startTestServer({
      processes: processes.service,
      spec: twoResourceProjectSpec(),
    });
    const socket = await connectControl(server.url, "test-token");
    const response = nextMessage(socket);
    socket.send(JSON.stringify(createStartProjectMessage(resolve(import.meta.dir, ".."), {})));

    const parsed = parseDaemonServerMessage(JSON.parse(await response));
    expect(parsed).toMatchObject({
      output: {
        kind: "failed",
        report: { diagnostics: [{ code: "SYD4998" }, { code: "SYD4999" }] },
      },
      success: true,
    });
    expect((await Effect.runPromise(manager.listActiveProjects)).projects).toHaveLength(1);

    Effect.runSync(Deferred.succeed(cleanupGate, undefined));
    await waitFor(async () =>
      (await Effect.runPromise(manager.listActiveProjects)).projects.length === 0
        ? true
        : undefined,
    );
    socket.terminate();
  });
});

describe("service port allocation", () => {
  test("falls back from occupied preferences and releases reservations", async () => {
    const occupied = bindPort(0);
    const runtime = ManagedRuntime.make(BunPortAllocatorLayer);
    const allocator = await runtime.runPromise(PortAllocator);
    try {
      const first = await Effect.runPromise(allocator.reserve(occupied.port));
      const second = await Effect.runPromise(allocator.reserve(undefined));
      expect(first.port).not.toBe(occupied.port);
      expect(second.port).not.toBe(first.port);

      const port = first.port;
      await Effect.runPromise(first.releaseReservation);
      const rebound = bindPort(port);
      await rebound.stop(true);

      await Effect.runPromise(first.dispose);
      await Effect.runPromise(first.dispose);
      await Effect.runPromise(second.dispose);
      const reused = await Effect.runPromise(allocator.reserve(port));
      expect(reused.port).toBe(port);
      await Effect.runPromise(reused.dispose);
    } finally {
      await runtime.dispose();
      await occupied.stop(true);
    }
  });
});

describe("service process lifecycle", () => {
  test("stops descendants with their managed process", async () => {
    const resources = await createPlatformServices();
    const lease = await Effect.runPromise(resources.ports.reserve(undefined));
    let handle: ProcessHandle | undefined;
    try {
      await Effect.runPromise(lease.releaseReservation);
      handle = await Effect.runPromise(
        resources.processes.start({
          args: [resolve(import.meta.dir, "fixtures/process-tree.ts")],
          env: { ...stringEnvironment(process.env), CHILD_PORT: String(lease.port) },
          executable: process.execPath,
          logs: discardLogs,
          projectRoot: resolve(import.meta.dir, ".."),
          workingDirectory: ".",
        }),
      );
      await waitForEndpoint(lease.port);
      await Effect.runPromise(handle.stop);
      await waitForEndpointStop(lease.port);
    } finally {
      if (handle) {
        await Effect.runPromise(handle.stop);
      }
      await Effect.runPromise(lease.dispose);
      await resources.dispose();
    }
  }, 10_000);

  test("reaps descendants when their leader exits naturally", async () => {
    const resources = await createPlatformServices();
    const lease = await Effect.runPromise(resources.ports.reserve(undefined));
    let childPid: number | undefined;
    let handle: ProcessHandle | undefined;
    const logs: ProcessLogLine[] = [];
    try {
      await Effect.runPromise(lease.releaseReservation);
      handle = await Effect.runPromise(
        resources.processes.start({
          args: [resolve(import.meta.dir, "fixtures/process-tree.ts"), "orphan"],
          env: { ...stringEnvironment(process.env), CHILD_PORT: String(lease.port) },
          executable: process.execPath,
          logs: { write: (entries) => logs.push(...entries) },
          projectRoot: resolve(import.meta.dir, ".."),
          workingDirectory: ".",
        }),
      );
      const exited = await Effect.runPromise(handle.exited);
      expect(exited.cleanup.success).toBeTrue();
      expect(exited.exitCode).toBe(0);
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
        await Effect.runPromise(handle.stop);
      }
      if (childPid && isProcessAlive(childPid)) {
        await forceStopProcess(childPid);
      }
      await Effect.runPromise(lease.dispose);
      await resources.dispose();
    }
  }, 10_000);

  test("reaps a service tree when its owning process is killed", async () => {
    const runtime = ManagedRuntime.make(BunPortAllocatorLayer);
    const ports = await runtime.runPromise(PortAllocator);
    const lease = await Effect.runPromise(ports.reserve(undefined));
    let owner: Bun.Subprocess<"ignore", "pipe", "ignore"> | undefined;
    let servicePid: number | undefined;
    try {
      await Effect.runPromise(lease.releaseReservation);
      owner = Bun.spawn({
        cmd: [process.execPath, resolve(import.meta.dir, "fixtures/process-owner.ts")],
        env: { ...stringEnvironment(process.env), CHILD_PORT: String(lease.port) },
        stderr: "ignore",
        stdin: "ignore",
        stdout: "pipe",
        windowsHide: true,
      });
      servicePid = await readProcessIdentifier(owner.stdout);
      await waitForEndpoint(lease.port);
      owner.kill("SIGKILL");
      await owner.exited;
      await waitForEndpointStop(lease.port);
      await waitFor(() => (servicePid && !isProcessAlive(servicePid) ? true : undefined));
    } finally {
      if (owner?.exitCode === null) {
        owner.kill("SIGKILL");
        await owner.exited;
      }
      if (servicePid && isProcessAlive(servicePid)) {
        await forceStopProcessTree(servicePid);
      }
      await Effect.runPromise(lease.dispose);
      await runtime.dispose();
    }
  }, 10_000);
});

interface TestServerOptions {
  readonly orchestrator?: ProjectOrchestrator["Service"];
  readonly port?: number;
  readonly processes?: ProcessHost["Service"];
  readonly requestShutdown?: () => void;
  readonly spec?: ProjectSpec;
}

interface TestServer {
  readonly manager: ProjectManager["Service"];
  readonly runtime: ControlRuntime;
  readonly server: Bun.Server<ControlData>;
  readonly sockets: Set<Bun.ServerWebSocket<ControlData>>;
}

async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const started = await tryStartTestServer(options);
  if (!started.ok) {
    throw new Error(started.error.diagnostics[0].message);
  }
  return started.value;
}

async function tryStartTestServer(
  options: TestServerOptions = {},
): Promise<Outcome<TestServer, Failure>> {
  const managerLayer = makeProjectManagerLayer({ diagnostics }).pipe(
    Layer.provide(
      Layer.merge(
        BunPortAllocatorLayer,
        options.processes
          ? Layer.succeed(ProcessHost, options.processes)
          : makeBunProcessHostLayer(diagnostics),
      ),
    ),
  );
  const orchestratorLayer = options.orchestrator
    ? Layer.succeed(ProjectOrchestrator, options.orchestrator)
    : makeTestOrchestratorLayer(options.spec ?? projectSpec());
  const controlLayer = orchestratorLayer.pipe(Layer.provideMerge(managerLayer));
  const runtime = ManagedRuntime.make(controlLayer);
  const manager = await runtime.runPromise(ProjectManager);
  const sockets = new Set<Bun.ServerWebSocket<ControlData>>();
  const started = await outcome(
    startControlServer({
      diagnostics,
      instanceId: "test-daemon",
      isShuttingDown: () => false,
      onClose: (socket) => sockets.delete(socket),
      onOpen: (socket) => sockets.add(socket),
      port: options.port ?? 0,
      requestShutdown: options.requestShutdown ?? (() => {}),
      runtime,
      token: "test-token",
    }),
  );
  if (!started.ok) {
    await runtime.dispose();
    return started;
  }
  const value = { manager, runtime, server: started.value, sockets };
  disposeTests.push(async () => {
    await Effect.runPromise(closeControlServer(runtime, sockets, diagnostics));
    await value.server.stop(true);
    await runtime.dispose();
  });
  return { ok: true, value };
}

function makeTestOrchestratorLayer(spec: ProjectSpec) {
  return Layer.effect(
    ProjectOrchestrator,
    Effect.gen(function* () {
      const manager = yield* ProjectManager;
      return ProjectOrchestrator.of({
        add: () => Effect.die(new Error("Unexpected project add request.")),
        list: Effect.succeed([]),
        remove: () => Effect.die(new Error("Unexpected project remove request.")),
        start: (input) => manager.start({ ...input, id: "project-one", revision: 1, spec }),
        stop: () => manager.stop("project-one").pipe(Effect.as(stoppedProject(spec.name, spec))),
      });
    }),
  );
}

function stoppedProject(name: string, spec: ProjectSpec): Project {
  return {
    id: "project-one",
    name,
    restartRequired: false,
    root: resolve(import.meta.dir, ".."),
    services: Object.keys(spec.resources).map((serviceName) => ({
      endpoints: [],
      name: serviceName,
      state: "stopped",
    })),
    state: "stopped",
  };
}

async function expectManagedResourcesReleased(
  runtimeDirectory: string,
  port: number,
): Promise<void> {
  expect(await readLocator(runtimeDirectory)).toBeUndefined();
  const lock = await Effect.runPromise(acquireDaemonLock(runtimeDirectory, "after-shutdown"));
  expect(lock).toBeDefined();
  if (lock) {
    await Effect.runPromise(lock.release);
  }
  const rebound = bindPort(port);
  await rebound.stop(true);
}

function bindPort(port: number): Bun.Server<undefined> {
  return Bun.serve({
    fetch: () => new Response(null),
    hostname: "127.0.0.1",
    port,
  });
}

function authorized(): RequestInit {
  return { headers: { authorization: "Bearer test-token" } };
}

function projectRequest(
  server: Bun.Server<ControlData>,
  path: string,
  method: "DELETE" | "POST",
  body: Readonly<Record<string, string>>,
): Promise<Response> {
  return fetch(new URL(path, server.url), {
    body: JSON.stringify(body),
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    },
    method,
  });
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

function projectSpec(): ProjectSpec {
  return validProjectSpec({
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
}

function twoResourceProjectSpec(): ProjectSpec {
  const resource = {
    command: { args: [], executable: "fixture" },
    cwd: ".",
    endpoints: {},
    env: {},
    kind: "process" as const,
  };
  return validProjectSpec({
    name: "failure-fixture",
    resources: { api: resource, web: resource },
  });
}

function validProjectSpec(input: Parameters<typeof createProjectSpec>[0]): ProjectSpec {
  const created = createProjectSpec(input);
  if (!created.success) {
    throw new Error("Test project specification is invalid.");
  }
  return created.output;
}

class ImmediateProcesses {
  readonly handle = new ControlledHandle();
  readonly service = ProcessHost.of({ start: () => Effect.succeed(this.handle) });
}

class BlockingProcesses {
  readonly started = Deferred.makeUnsafe<void>();
  readonly service: ProcessHost["Service"];
  interrupted = false;

  constructor() {
    this.service = ProcessHost.of({
      start: () =>
        Deferred.succeed(this.started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              this.interrupted = true;
            }),
          ),
        ),
    });
  }
}

class FailingStartProcesses {
  readonly handle: ControlledHandle;
  readonly service: ProcessHost["Service"];
  #starts = 0;

  constructor(cleanupGate: Deferred.Deferred<void>) {
    this.handle = new ControlledHandle(cleanupGate);
    this.handle.stopFailures = 1;
    this.service = ProcessHost.of({
      start: () =>
        Effect.suspend(() => {
          this.#starts += 1;
          return this.#starts === 1
            ? Effect.succeed<ProcessHandle>(this.handle)
            : Effect.fail(
                failure(createDiagnostic({ code: "SYD4999", message: "Expected start failure." })),
              );
        }),
    });
  }
}

class ControlledHandle implements ProcessHandle {
  readonly #exit = Deferred.makeUnsafe<ProcessExit>();
  readonly exited = Deferred.await(this.#exit);
  readonly leaderExited = this.exited.pipe(Effect.map(({ exitCode }) => exitCode));
  readonly pid = 1;
  readonly stop: Effect.Effect<void, Failure>;
  stopFailures = 0;
  stopCount = 0;

  constructor(stopGate?: Deferred.Deferred<void>) {
    this.stop = Effect.suspend(() => {
      this.stopCount += 1;
      if (this.stopFailures > 0) {
        this.stopFailures -= 1;
        return Effect.fail(
          failure(createDiagnostic({ code: "SYD4998", message: "Expected stop failure." })),
        );
      }
      return (stopGate ? Deferred.await(stopGate) : Effect.void).pipe(
        Effect.andThen(
          Deferred.succeed(this.#exit, {
            cleanup: success(undefined),
            exitCode: 0,
            logCapture: success(undefined),
          }),
        ),
        Effect.asVoid,
      );
    });
  }
}

async function createPlatformServices() {
  const runtime = ManagedRuntime.make(
    Layer.merge(BunPortAllocatorLayer, makeBunProcessHostLayer(diagnostics)),
  );
  return {
    dispose: () => runtime.dispose(),
    ports: await runtime.runPromise(PortAllocator),
    processes: await runtime.runPromise(ProcessHost),
  };
}

type Outcome<A, E> =
  | { readonly ok: false; readonly error: E }
  | { readonly ok: true; readonly value: A };

function outcome<A, E>(effect: Effect.Effect<A, E>): Promise<Outcome<A, E>> {
  return Effect.runPromise(
    effect.pipe(
      Effect.match({
        onFailure: (error): Outcome<A, E> => ({ error, ok: false }),
        onSuccess: (value): Outcome<A, E> => ({ ok: true, value }),
      }),
    ),
  );
}

function readLocator(runtimeDirectory: string) {
  return Effect.runPromise(readLocatorEffect(runtimeDirectory));
}

async function waitForEndpoint(port: number): Promise<void> {
  await waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}`);
      return response.ok ? true : undefined;
    } catch {
      return undefined;
    }
  });
}

async function waitForEndpointStop(port: number): Promise<void> {
  await waitFor(async () => {
    try {
      await fetch(`http://127.0.0.1:${port}`);
      return undefined;
    } catch {
      return true;
    }
  });
}

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

function isProcessAlive(pid: number | undefined): boolean {
  if (pid === undefined) {
    return false;
  }
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
    /* oxlint-disable-next-line eslint/no-await-in-loop -- The identifier is one ordered output line. */
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
