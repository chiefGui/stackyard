import { realpath } from "node:fs/promises";

import { ProjectManager, type ManagedProject } from "@stackyard/control-plane";
import {
  createDiagnostic,
  createDiagnosticReport,
  describeError,
  failure,
  success,
  type DiagnosticSink,
  type Result,
} from "@stackyard/diagnostics";
import {
  createDaemonFailureMessage,
  createProjectCompletedMessage,
  createProjectStartedMessage,
  createProjectStoppedMessage,
  createProjectList,
  parseDaemonClientMessage,
  protocolVersion,
  type DaemonClientMessage,
} from "@stackyard/protocol";

import { superviseCleanup } from "./cleanup.ts";
import { daemonHostname } from "./locator.ts";

const maximumControlMessageBytes = 4 * 1024 * 1024;

export interface ControlData {
  readonly cancellation: AbortController;
  project?: ManagedProject;
  queue: Promise<void>;
  startReceived: boolean;
  stopRequested: boolean;
}

export type UnhandledRequestHandler = (request: Request, url: URL) => Promise<Response> | Response;

export interface ControlServerOptions {
  readonly diagnostics: DiagnosticSink;
  readonly instanceId: string;
  readonly isShuttingDown: () => boolean;
  readonly manager: ProjectManager;
  readonly port: number;
  readonly token: string;
  readonly handleUnhandledRequest?: UnhandledRequestHandler;
  onActivity(): void;
  onClose(socket: Bun.ServerWebSocket<ControlData>): void;
  onOpen(socket: Bun.ServerWebSocket<ControlData>): void;
}

export function startControlServer(options: ControlServerOptions): Result<Bun.Server<ControlData>> {
  try {
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
        if (url.hostname !== daemonHostname) {
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
          if (upgraded) {
            return undefined;
          }
          return secureResponse("WebSocket upgrade required.", { status: 426 });
        }

        if (request.method !== "GET") {
          return secureResponse("Method not allowed.", { status: 405 });
        }
        if (url.pathname === "/health") {
          return secureJson({ instanceId: options.instanceId, protocolVersion, status: "ok" });
        }
        if (url.pathname === "/api/v1/projects") {
          return secureJson(createProjectList(options.manager.listProjects()));
        }
        if (!options.handleUnhandledRequest) {
          return secureResponse("Not found.", { status: 404 });
        }
        return secureUnhandledResponse(options.handleUnhandledRequest(request, url));
      },
      hostname: daemonHostname,
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

export async function closeControlServer(
  manager: ProjectManager,
  sockets: ReadonlySet<Bun.ServerWebSocket<ControlData>>,
  diagnostics: DiagnosticSink,
): Promise<void> {
  for (const socket of sockets) {
    socket.data.cancellation.abort();
  }

  const queueSettlement = Promise.allSettled([...sockets].map(({ data }) => data.queue));
  const cleanupTasks: Promise<void>[] = [];
  for (const socket of sockets) {
    const project = socket.data.project;
    if (project) {
      cleanupTasks.push(superviseCleanup(() => project.stop(), diagnostics));
    }
  }
  await Promise.all([queueSettlement, Promise.all(cleanupTasks)]);
  await superviseCleanup(() => manager.stopAll(), diagnostics);
}

async function handleControlMessage(
  socket: Bun.ServerWebSocket<ControlData>,
  parsed: Result<DaemonClientMessage>,
  acceptedStart: boolean,
  manager: ProjectManager,
  diagnostics: DiagnosticSink,
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
          message: "This daemon connection does not own an active project.",
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
        help: "Open a new Stackyard connection for each active project.",
        message: "This daemon connection already owns an active project.",
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
  const announced = sendMessage(socket, createProjectStartedMessage(started.output.id));
  if (!announced) {
    await superviseCleanup(() => started.output.stop(), diagnostics);
    return;
  }
  void started.output.completed.then(async (completion) => {
    if (completion.kind === "stopped" || socket.data.stopRequested) {
      return;
    }
    let message;
    if (completion.result.success) {
      message = createProjectCompletedMessage(0);
    } else {
      message = createDaemonFailureMessage(createDiagnosticReport(completion.result.diagnostics));
    }
    const sent = sendMessage(socket, message);
    if (!sent) {
      await superviseCleanup(() => started.output.stop(), diagnostics);
    }
  });
}

function parseControlPayload(
  payload: string | ArrayBuffer | Uint8Array,
): Result<DaemonClientMessage> {
  try {
    let text: string;
    if (typeof payload === "string") {
      text = payload;
    } else {
      text = new TextDecoder().decode(payload);
    }
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

function secureJson(value: unknown): Response {
  return secure(Response.json(value, { headers: { "cache-control": "no-store" } }));
}

function secureResponse(
  body: ConstructorParameters<typeof Response>[0],
  init: ResponseInit,
): Response {
  return secure(new Response(body, init));
}

async function secureUnhandledResponse(response: Promise<Response> | Response): Promise<Response> {
  return secure(await response);
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
