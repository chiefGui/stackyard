import { realpath } from "node:fs/promises";
import { extname, join, normalize, relative, resolve } from "node:path";

import { RunManager, type ManagedProject } from "@stackyard/control-plane";
import {
  createDiagnostic,
  createDiagnosticReport,
  describeError,
  failure,
  reportDiagnostics,
  success,
  type DiagnosticSink,
  type Result,
} from "@stackyard/diagnostics";
import {
  createDaemonFailureMessage,
  createProjectCompletedMessage,
  createProjectStartedMessage,
  createProjectStoppedMessage,
  parseDaemonClientMessage,
  protocolVersion,
  type DaemonClientMessage,
} from "@stackyard/protocol";

import { superviseCleanup } from "./cleanup.ts";
import { acquireDaemonLock, publishLocator, removeLocator, runtimeDirectory } from "./locator.ts";
import { BunPortAllocator } from "./ports.ts";
import { BunProcessHost } from "./processes.ts";

const hostname = "127.0.0.1";
const idleMilliseconds = 15_000;
const maximumControlMessageBytes = 4 * 1024 * 1024;

interface ControlData {
  readonly cancellation: AbortController;
  project?: ManagedProject;
  queue: Promise<void>;
  startReceived: boolean;
  stopRequested: boolean;
}

export interface ManagedDaemonOptions {
  readonly dashboardDirectory: string;
  readonly diagnostics: DiagnosticSink;
  readonly runtimeDirectory?: string;
}

export async function runManagedDaemon(options: ManagedDaemonOptions): Promise<number> {
  const directory = runtimeDirectory(options.runtimeDirectory);
  const instanceId = crypto.randomUUID();
  const lockResult = await acquireDaemonLock(directory, instanceId);
  if (!lockResult.success) {
    reportDiagnostics(options.diagnostics, lockResult.diagnostics);
    return 1;
  }
  if (!lockResult.output) {
    return 0;
  }

  const lock = lockResult.output;
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
  const manager = createRunManager(options.diagnostics);
  const sockets = new Set<Bun.ServerWebSocket<ControlData>>();
  let shuttingDown = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let finish = noop;
  let locatorPublished = false;
  let server: Bun.Server<ControlData> | undefined;
  let exitCode = 0;

  try {
    const started = startDaemonServer({
      dashboardDirectory: options.dashboardDirectory,
      diagnostics: options.diagnostics,
      instanceId,
      isShuttingDown: () => shuttingDown,
      manager,
      onClose(socket) {
        sockets.delete(socket);
        scheduleIdleShutdown();
      },
      onActivity() {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = undefined;
        }
        scheduleIdleShutdown();
      },
      onOpen(socket) {
        sockets.add(socket);
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = undefined;
        }
      },
      port: 0,
      token,
    });
    if (!started.success) {
      reportDiagnostics(options.diagnostics, started.diagnostics);
      return 1;
    }

    server = started.output;
    if (server.port === undefined) {
      options.diagnostics.report(
        createDiagnostic({
          code: "SYD3001",
          help: "Restart Stackyard, then retry.",
          message: "The daemon did not expose its allocated port.",
        }),
      );
      return 1;
    }

    await publishLocator(directory, {
      instanceId,
      pid: process.pid,
      port: server.port,
      token,
    });
    locatorPublished = true;

    const shutdown = new Promise<void>((finishShutdown) => {
      finish = finishShutdown;
    });
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
    scheduleIdleShutdown();
    await shutdown;
  } catch (error) {
    options.diagnostics.report(
      lifecycleDiagnostic("The Stackyard daemon stopped unexpectedly.", error),
    );
    exitCode = 1;
  } finally {
    shuttingDown = true;
    process.off("SIGINT", finish);
    process.off("SIGTERM", finish);
    if (idleTimer) {
      clearTimeout(idleTimer);
    }

    await closeRuntime(manager, sockets, options.diagnostics);
    if (server) {
      try {
        await server.stop(true);
      } catch (error) {
        options.diagnostics.report(lifecycleDiagnostic("The daemon server could not stop.", error));
        exitCode = 1;
      }
    }
    if (locatorPublished) {
      try {
        await removeLocator(directory, instanceId);
      } catch (error) {
        options.diagnostics.report(
          lifecycleDiagnostic("The daemon locator could not be removed.", error),
        );
        exitCode = 1;
      }
    }
    try {
      await lock.release();
    } catch (error) {
      options.diagnostics.report(
        lifecycleDiagnostic("The daemon lock could not be released.", error),
      );
      exitCode = 1;
    }
  }
  return exitCode;

  function scheduleIdleShutdown(): void {
    if (sockets.size > 0 || manager.snapshot().projects.length > 0 || idleTimer) {
      return;
    }
    idleTimer = setTimeout(finish, idleMilliseconds);
  }
}

export interface ForegroundDaemonOptions {
  readonly dashboardDirectory: string;
  readonly diagnostics: DiagnosticSink;
  readonly onStarted?: (url: string) => void;
  readonly port: number;
}

export async function runForegroundDaemon(options: ForegroundDaemonOptions): Promise<number> {
  const manager = createRunManager(options.diagnostics);
  const sockets = new Set<Bun.ServerWebSocket<ControlData>>();
  let shuttingDown = false;
  const started = startDaemonServer({
    dashboardDirectory: options.dashboardDirectory,
    diagnostics: options.diagnostics,
    instanceId: crypto.randomUUID(),
    isShuttingDown: () => shuttingDown,
    manager,
    onActivity: noop,
    onClose(socket) {
      sockets.delete(socket);
    },
    onOpen(socket) {
      sockets.add(socket);
    },
    port: options.port,
    token: `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", ""),
  });
  if (!started.success) {
    reportDiagnostics(options.diagnostics, started.diagnostics);
    return 1;
  }

  const server = started.output;
  let finish = noop;
  let exitCode = 0;
  try {
    options.onStarted?.(server.url.href);
    const shutdown = new Promise<void>((resolveShutdown) => {
      finish = resolveShutdown;
    });
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
    await shutdown;
  } catch (error) {
    options.diagnostics.report(
      lifecycleDiagnostic("The Stackyard daemon stopped unexpectedly.", error),
    );
    exitCode = 1;
  } finally {
    shuttingDown = true;
    process.off("SIGINT", finish);
    process.off("SIGTERM", finish);
    await closeRuntime(manager, sockets, options.diagnostics);
    try {
      await server.stop(true);
    } catch (error) {
      options.diagnostics.report(lifecycleDiagnostic("The daemon server could not stop.", error));
      exitCode = 1;
    }
  }
  return exitCode;
}

function createRunManager(diagnostics: DiagnosticSink): RunManager {
  return new RunManager({
    createId: () => crypto.randomUUID(),
    ports: new BunPortAllocator(),
    processes: new BunProcessHost(diagnostics),
  });
}

export interface DaemonServerOptions {
  readonly dashboardDirectory: string;
  readonly diagnostics: DiagnosticSink;
  readonly instanceId: string;
  readonly isShuttingDown: () => boolean;
  readonly manager: RunManager;
  readonly port: number;
  readonly token: string;
  onActivity(): void;
  onClose(socket: Bun.ServerWebSocket<ControlData>): void;
  onOpen(socket: Bun.ServerWebSocket<ControlData>): void;
}

export function startDaemonServer(options: DaemonServerOptions): Result<Bun.Server<ControlData>> {
  try {
    const dashboardRoot = resolve(options.dashboardDirectory);
    let server!: Bun.Server<ControlData>;
    server = Bun.serve<ControlData>({
      error(error) {
        options.diagnostics.report(
          createDiagnostic({
            code: "SYD3013",
            help: "Retry the request. If the problem persists, restart Stackyard.",
            message: "The daemon could not complete a local request.",
            notes: [describeError(error)],
          }),
        );
        return secureResponse("Internal server error.", { status: 500 });
      },
      fetch(request, activeServer) {
        const url = new URL(request.url);
        if (url.hostname !== hostname) {
          return secureResponse("Invalid host.", { status: 403 });
        }
        options.onActivity();

        if (url.pathname === "/api/v1/control") {
          if (options.isShuttingDown()) {
            return secureResponse("Daemon is shutting down.", { status: 503 });
          }
          if (request.headers.get("authorization") !== `Bearer ${options.token}`) {
            return secureResponse("Unauthorized.", { status: 401 });
          }

          const upgraded = activeServer.upgrade(request, {
            data: {
              cancellation: new AbortController(),
              queue: Promise.resolve(),
              startReceived: false,
              stopRequested: false,
            },
          });
          return upgraded
            ? undefined
            : secureResponse("WebSocket upgrade required.", { status: 426 });
        }

        if (request.method !== "GET") {
          return secureResponse("Method not allowed.", { status: 405 });
        }
        if (url.pathname === "/health") {
          return secureJson({ instanceId: options.instanceId, protocolVersion, status: "ok" });
        }
        if (url.pathname === "/api/v1/snapshot") {
          return secureJson(options.manager.snapshot());
        }

        return dashboardResponse(dashboardRoot, url.pathname);
      },
      hostname,
      maxRequestBodySize: maximumControlMessageBytes,
      port: options.port,
      websocket: {
        close(socket) {
          socket.data.cancellation.abort();
          socket.data.queue = socket.data.queue
            .catch((error: unknown) => {
              options.diagnostics.report(controlMessageDiagnostic(error));
            })
            .then(async () => {
              const project = socket.data.project;
              if (project) {
                await superviseCleanup(() => project.stop(), options.diagnostics);
              }
            })
            .finally(() => options.onClose(socket));
        },
        idleTimeout: 0,
        maxPayloadLength: maximumControlMessageBytes,
        message(socket, payload) {
          if (options.isShuttingDown()) {
            socket.data.cancellation.abort();
            return;
          }
          const parsed = parseControlPayload(payload);
          let acceptedStart = false;
          if (parsed.success) {
            if (parsed.output.kind === "start") {
              acceptedStart = !socket.data.startReceived;
              socket.data.startReceived = true;
            } else if (socket.data.startReceived) {
              socket.data.stopRequested = true;
              socket.data.cancellation.abort();
            }
          }
          socket.data.queue = socket.data.queue
            .then(() =>
              handleControlMessage(
                socket,
                parsed,
                acceptedStart,
                options.manager,
                options.diagnostics,
                server.url.href,
              ),
            )
            .catch((error: unknown) => {
              const diagnostic = controlMessageDiagnostic(error);
              options.diagnostics.report(diagnostic);
              sendFailure(socket, diagnostic);
            });
        },
        open(socket) {
          options.onOpen(socket);
        },
      },
    });

    return success(server);
  } catch (error) {
    return failure(
      createDiagnostic({
        code: "SYD3001",
        help: "Check the Stackyard runtime directory and local networking, then retry.",
        message: "The Stackyard daemon could not start.",
        notes: [describeError(error)],
      }),
    );
  }
}

async function closeRuntime(
  manager: RunManager,
  sockets: ReadonlySet<Bun.ServerWebSocket<ControlData>>,
  diagnostics: DiagnosticSink,
): Promise<void> {
  for (const socket of sockets) {
    socket.data.cancellation.abort();
  }

  const queueSettlement = Promise.allSettled([...sockets].map(({ data }) => data.queue));
  const projectCleanup = Promise.all(
    [...sockets].flatMap(({ data }) => {
      const project = data.project;
      return project ? [superviseCleanup(() => project.stop(), diagnostics)] : [];
    }),
  );
  await Promise.all([queueSettlement, projectCleanup]);
  await superviseCleanup(() => manager.stopAll(), diagnostics);
}

async function handleControlMessage(
  socket: Bun.ServerWebSocket<ControlData>,
  parsed: Result<DaemonClientMessage>,
  acceptedStart: boolean,
  manager: RunManager,
  diagnostics: DiagnosticSink,
  dashboardUrl: string,
): Promise<void> {
  if (!parsed.success) {
    sendMessage(socket, createDaemonFailureMessage(createDiagnosticReport(parsed.diagnostics)));
    return;
  }

  if (parsed.output.kind === "stop") {
    if (!socket.data.project) {
      if (socket.data.startReceived && socket.data.stopRequested) {
        sendMessage(socket, createProjectStoppedMessage());
        return;
      }
      sendFailure(
        socket,
        createDiagnostic({
          code: "SYD3012",
          help: "Start a project on this connection before requesting a stop.",
          message: "This daemon connection does not own a project run.",
        }),
      );
      return;
    }
    const stopped = await socket.data.project.stop();
    if (!stopped.success) {
      sendMessage(socket, createDaemonFailureMessage(createDiagnosticReport(stopped.diagnostics)));
      return;
    }
    sendMessage(socket, createProjectStoppedMessage());
    return;
  }

  if (!acceptedStart || socket.data.project) {
    sendFailure(
      socket,
      createDiagnostic({
        code: "SYD3008",
        help: "Open a new Stackyard connection for each project run.",
        message: "This daemon connection already owns a project run.",
      }),
    );
    return;
  }
  if (socket.data.stopRequested) {
    return;
  }

  let root: string;
  try {
    root = await realpath(parsed.output.root);
  } catch (error) {
    sendFailure(
      socket,
      createDiagnostic({
        code: "SYD3009",
        help: "Verify that the project directory still exists, then retry.",
        message: "The project root could not be resolved.",
        notes: [describeError(error)],
      }),
    );
    return;
  }

  const started = await manager.start({
    environment: parsed.output.environment,
    environmentNamesCaseInsensitive: process.platform === "win32",
    root,
    signal: socket.data.cancellation.signal,
    spec: parsed.output.spec,
  });
  if (!started.success) {
    if (!socket.data.cancellation.signal.aborted) {
      sendMessage(socket, createDaemonFailureMessage(createDiagnosticReport(started.diagnostics)));
    }
    const cleanup = started.cleanup;
    if (cleanup) {
      await superviseCleanup(() => cleanup.stop(), diagnostics);
    }
    return;
  }

  socket.data.project = started.output;
  if (socket.data.cancellation.signal.aborted) {
    await superviseCleanup(() => started.output.stop(), diagnostics);
    return;
  }
  const announced = sendMessage(
    socket,
    createProjectStartedMessage(started.output.id, new URL("/", dashboardUrl).href),
  );
  if (!announced) {
    await superviseCleanup(() => started.output.stop(), diagnostics);
    return;
  }
  void started.output.completed.then(async (completion) => {
    if (completion.kind === "stopped" || socket.data.stopRequested) {
      return;
    }
    const sent = sendMessage(
      socket,
      completion.result.success
        ? createProjectCompletedMessage(0)
        : createDaemonFailureMessage(createDiagnosticReport(completion.result.diagnostics)),
    );
    if (!sent) {
      await superviseCleanup(() => started.output.stop(), diagnostics);
    }
  });
}

function parseControlPayload(
  payload: string | ArrayBuffer | Uint8Array,
): Result<DaemonClientMessage> {
  try {
    const text = typeof payload === "string" ? payload : new TextDecoder().decode(payload);
    return parseDaemonClientMessage(JSON.parse(text));
  } catch {
    return failure(
      createDiagnostic({
        code: "SYD3007",
        help: "Update Stackyard so the CLI and daemon use the same protocol, then retry.",
        message: "The daemon received malformed control data.",
      }),
    );
  }
}

async function dashboardResponse(root: string, pathname: string): Promise<Response> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return secureResponse("Invalid path.", { status: 400 });
  }

  const requested = decoded === "/" ? "index.html" : decoded.slice(1);
  const filePath = normalize(join(root, requested));
  const relativePath = relative(root, filePath);
  if (relativePath.startsWith("..") || relativePath.includes(":") || relativePath === "") {
    return secureResponse("Not found.", { status: 404 });
  }

  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return secureResponse("Not found.", { status: 404 });
  }
  return secure(
    new Response(file, {
      headers: {
        "cache-control":
          extname(filePath) === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
      },
    }),
  );
}

function secureJson(value: unknown): Response {
  return secure(Response.json(value, { headers: { "cache-control": "no-store" } }));
}

function secureResponse(
  body: ConstructorParameters<typeof Response>[0],
  init: ResponseInit,
): Response {
  return secure(new Response(body, init));
}

function secure(response: Response): Response {
  response.headers.set(
    "content-security-policy",
    "default-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("x-frame-options", "DENY");
  return response;
}

function sendFailure(
  socket: Bun.ServerWebSocket<ControlData>,
  diagnostic: ReturnType<typeof createDiagnostic>,
): void {
  sendMessage(socket, createDaemonFailureMessage(createDiagnosticReport([diagnostic])));
}

function sendMessage(socket: Bun.ServerWebSocket<ControlData>, message: unknown): boolean {
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    socket.data.cancellation.abort();
    return false;
  }
}

function controlMessageDiagnostic(error: unknown) {
  return createDiagnostic({
    code: "SYD3010",
    help: "Run the command again. If the problem persists, restart Stackyard.",
    message: "The daemon could not process a control message.",
    notes: [describeError(error)],
  });
}

function lifecycleDiagnostic(message: string, error: unknown) {
  return createDiagnostic({
    code: "SYD3011",
    help: "Restart Stackyard. If the problem persists, inspect the runtime directory and managed processes.",
    message,
    notes: [describeError(error)],
  });
}

function noop(): void {}
