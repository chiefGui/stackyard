import {
  ProjectManager,
  ProjectOrchestrator,
  type ManagedProject,
  type StartCatalogProjectInput,
} from "@stackyard/control-plane";
import {
  createDiagnostic,
  createDiagnosticReport,
  describeError,
  failure,
  type DiagnosticSink,
  type Failure,
  type Result,
} from "@stackyard/diagnostics";
import {
  createDaemonFailureMessage,
  createProjectCompletedMessage,
  createProject,
  createProjectList,
  createProjectStartedMessage,
  createProjectStoppedMessage,
  parseDaemonClientMessage,
  protocolVersion,
  type DaemonClientMessage,
} from "@stackyard/protocol";
import { Effect, Fiber, ManagedRuntime, Result as EffectResult, Schema } from "effect";

import { superviseCleanup } from "./cleanup.ts";
import { daemonHostname } from "./locator.ts";
import { handleResourceLogHttpRequest } from "./resource-log-http.ts";

const maximumMessageBytes = 4 * 1024 * 1024;
const ProjectPathRequestSchema = Schema.Struct({
  path: Schema.Trimmed.check(Schema.isNonEmpty()),
});
const ProjectTargetRequestSchema = Schema.Struct({
  target: Schema.Trimmed.check(Schema.isNonEmpty()),
});
const decodeProjectPathRequest = Schema.decodeUnknownResult(ProjectPathRequestSchema, {
  onExcessProperty: "error",
});
const decodeProjectTargetRequest = Schema.decodeUnknownResult(ProjectTargetRequestSchema, {
  onExcessProperty: "error",
});

type ControlServices = ProjectManager | ProjectOrchestrator;
export type ControlRuntime = ManagedRuntime.ManagedRuntime<ControlServices, Failure>;

export interface ControlData {
  closed: boolean;
  completion?: Fiber.Fiber<void, Failure>;
  pending?: Fiber.Fiber<void, Failure>;
  project?: ManagedProject;
  startReceived: boolean;
  stopRequested: boolean;
}

export type UnhandledRequestHandler = (request: Request, url: URL) => Effect.Effect<Response>;

export interface ControlServerOptions {
  readonly diagnostics: DiagnosticSink;
  readonly instanceId: string;
  readonly isShuttingDown: () => boolean;
  readonly port: number;
  readonly requestShutdown: () => void;
  readonly runtime: ControlRuntime;
  readonly token: string;
  readonly handleUnhandledRequest?: UnhandledRequestHandler;
  onClose(socket: Bun.ServerWebSocket<ControlData>): void;
  onOpen(socket: Bun.ServerWebSocket<ControlData>): void;
}

export const startControlServer = Effect.fn("startControlServer")(
  (options: ControlServerOptions): Effect.Effect<Bun.Server<ControlData>, Failure> =>
    Effect.try({
      try: () => {
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
            if (url.pathname === "/api/v1/control") {
              if (options.isShuttingDown()) {
                return secureResponse("Daemon is shutting down.", { status: 503 });
              }
              if (request.headers.get("authorization") !== `Bearer ${options.token}`) {
                return secureResponse("Unauthorized.", { status: 401 });
              }
              const upgraded = activeServer.upgrade(request, {
                data: {
                  closed: false,
                  startReceived: false,
                  stopRequested: false,
                },
              });
              return upgraded
                ? undefined
                : secureResponse("WebSocket upgrade required.", { status: 426 });
            }

            if (url.pathname === "/api/v1/shutdown") {
              if (request.headers.get("authorization") !== `Bearer ${options.token}`) {
                return secureResponse("Unauthorized.", { status: 401 });
              }
              if (request.method !== "POST") {
                return secureResponse("Method not allowed.", { status: 405 });
              }
              if (!options.isShuttingDown()) {
                options.requestShutdown();
              }
              return secureResponse(null, { status: 202 });
            }

            if (url.pathname === "/api/v1/projects/stop") {
              if (request.headers.get("authorization") !== `Bearer ${options.token}`) {
                return secureResponse("Unauthorized.", { status: 401 });
              }
              if (request.method !== "POST") {
                return secureResponse("Method not allowed.", { status: 405 });
              }
              if (options.isShuttingDown()) {
                return secureResponse("Daemon is shutting down.", { status: 503 });
              }
              return runHttp(options, handleProjectStopRequest(request));
            }

            if (url.pathname === "/api/v1/projects") {
              if (request.method === "GET") {
                return runHttp(
                  options,
                  ProjectOrchestrator.use((projects) =>
                    projects.list.pipe(
                      Effect.map((items) => secureJson(createProjectList({ projects: items }))),
                    ),
                  ),
                );
              }
              if (request.headers.get("authorization") !== `Bearer ${options.token}`) {
                return secureResponse("Unauthorized.", { status: 401 });
              }
              if (request.method !== "POST" && request.method !== "DELETE") {
                return secureResponse("Method not allowed.", { status: 405 });
              }
              if (options.isShuttingDown()) {
                return secureResponse("Daemon is shutting down.", { status: 503 });
              }
              return runHttp(options, handleProjectRequest(request));
            }

            if (request.method !== "GET") {
              return secureResponse("Method not allowed.", { status: 405 });
            }
            if (url.pathname === "/health") {
              return secureJson({ instanceId: options.instanceId, protocolVersion, status: "ok" });
            }

            const logs = handleResourceLogHttpRequest(request, url, {
              disableRequestTimeout: () => activeServer.timeout(request, 0),
              isShuttingDown: options.isShuttingDown,
              token: options.token,
            });
            const dashboard = options.handleUnhandledRequest
              ? options.handleUnhandledRequest(request, url)
              : Effect.succeed(secureResponse("Not found.", { status: 404 }));
            return runHttp(
              options,
              logs.pipe(
                Effect.flatMap((response) => (response ? Effect.succeed(response) : dashboard)),
                Effect.map(secure),
              ),
            );
          },
          hostname: daemonHostname,
          maxRequestBodySize: maximumMessageBytes,
          port: options.port,
          websocket: {
            close(socket) {
              socket.data.closed = true;
              const pending = socket.data.pending;
              const completion = socket.data.completion;
              options.runtime.runFork(
                Effect.gen(function* () {
                  if (pending) {
                    yield* Fiber.interrupt(pending);
                  }
                  if (completion) {
                    yield* Fiber.interrupt(completion);
                  }
                  if (socket.data.project) {
                    yield* superviseCleanup(socket.data.project.stop, options.diagnostics);
                  }
                }).pipe(Effect.ensuring(Effect.sync(() => options.onClose(socket)))),
              );
            },
            idleTimeout: 0,
            maxPayloadLength: maximumMessageBytes,
            message(socket, payload) {
              if (options.isShuttingDown()) {
                socket.data.closed = true;
                interruptPending(socket.data, options.runtime);
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
                  interruptPending(socket.data, options.runtime);
                }
              }
              enqueueControl(
                socket,
                handleControlMessage(socket, parsed, acceptedStart, options),
                options,
              );
            },
            open(socket) {
              options.onOpen(socket);
            },
          },
        });
        return server;
      },
      catch: (error) =>
        failure(
          createDiagnostic({
            code: "SYD3001",
            help: "Check the Stackyard runtime directory and local networking, then retry.",
            message: "The Stackyard daemon could not start.",
            notes: [describeError(error)],
          }),
        ),
    }),
);

const handleProjectRequest = Effect.fn("handleProjectRequest")(function* (
  request: Request,
): Effect.fn.Return<Response, never, ProjectOrchestrator> {
  const input = yield* requestJson(request);
  if (!input.success) {
    return projectFailureResponse(invalidProjectRequest(), 400);
  }
  const decoded =
    request.method === "POST"
      ? EffectResult.map(decodeProjectPathRequest(input.value), ({ path }) => path)
      : EffectResult.map(decodeProjectTargetRequest(input.value), ({ target }) => target);
  if (EffectResult.isFailure(decoded)) {
    return projectFailureResponse(invalidProjectRequest(), 400);
  }
  const result = yield* ProjectOrchestrator.use((projects) =>
    (request.method === "POST"
      ? projects.add(decoded.success)
      : projects.remove(decoded.success)
    ).pipe(
      Effect.match({
        onFailure: (error) => ({ error, success: false as const }),
        onSuccess: (project) => ({ project, success: true as const }),
      }),
    ),
  );
  return result.success
    ? secureJson(createProject(result.project))
    : projectFailureResponse(
        result.error.diagnostics,
        projectFailureStatus(result.error.diagnostics[0]?.code),
      );
});

const handleProjectStopRequest = Effect.fn("handleProjectStopRequest")(function* (
  request: Request,
): Effect.fn.Return<Response, never, ProjectOrchestrator> {
  const input = yield* requestJson(request);
  const target = input.success ? decodeProjectTargetRequest(input.value) : undefined;
  if (!target || EffectResult.isFailure(target)) {
    return projectFailureResponse(invalidProjectRequest(), 400);
  }
  return yield* ProjectOrchestrator.use((projects) =>
    projects.stop(target.success.target).pipe(
      Effect.match({
        onFailure: (error) =>
          projectFailureResponse(
            error.diagnostics,
            projectFailureStatus(error.diagnostics[0]?.code),
          ),
        onSuccess: (project) => secureJson(createProject(project)),
      }),
    ),
  );
});

const requestJson = Effect.fn("requestJson")((request: Request) =>
  Effect.tryPromise({
    try: () => request.json(),
    catch: () => undefined,
  }).pipe(
    Effect.match({
      onFailure: () => ({ success: false as const }),
      onSuccess: (value) => ({ success: true as const, value }),
    }),
  ),
);

export const closeControlServer = Effect.fn("closeControlServer")(function* (
  runtime: ControlRuntime,
  sockets: ReadonlySet<Bun.ServerWebSocket<ControlData>>,
  diagnostics: DiagnosticSink,
) {
  const fibers = [...sockets].flatMap(({ data }) =>
    [data.pending, data.completion].filter((fiber): fiber is Fiber.Fiber<void, Failure> =>
      Boolean(fiber),
    ),
  );
  yield* Effect.forEach(fibers, Fiber.interrupt, { concurrency: "unbounded" });
  yield* Effect.forEach(
    [...sockets],
    ({ data }) => (data.project ? superviseCleanup(data.project.stop, diagnostics) : Effect.void),
    { concurrency: "unbounded" },
  );
  const built = yield* runtime.contextEffect.pipe(
    Effect.match({
      onFailure: (error) => ({ error, success: false as const }),
      onSuccess: (context) => ({ context, success: true as const }),
    }),
  );
  if (!built.success) {
    for (const diagnostic of built.error.diagnostics) {
      diagnostics.report(diagnostic);
    }
    return;
  }
  yield* ProjectManager.use((manager) => superviseCleanup(manager.stopAll, diagnostics)).pipe(
    Effect.provideContext(built.context),
  );
  for (const socket of sockets) {
    sendMessage(socket, createProjectStoppedMessage());
  }
});

const handleControlMessage = Effect.fn("handleControlMessage")(function* (
  socket: Bun.ServerWebSocket<ControlData>,
  parsed: Result<DaemonClientMessage>,
  acceptedStart: boolean,
  options: ControlServerOptions,
) {
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
    const stopped = yield* socket.data.project.stop.pipe(
      Effect.match({ onFailure: (error) => error, onSuccess: () => undefined }),
    );
    if (stopped) {
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
  if (socket.data.stopRequested || socket.data.closed) {
    return;
  }

  const startInput: StartCatalogProjectInput = {
    environment: parsed.output.environment,
    environmentNamesCaseInsensitive: process.platform === "win32",
    root: parsed.output.root,
  };
  const started = yield* ProjectOrchestrator.use((projects) => projects.start(startInput)).pipe(
    Effect.match({
      onFailure: (error) => ({ error, success: false as const }),
      onSuccess: (project) => ({ project, success: true as const }),
    }),
  );
  if (!started.success) {
    if (!socket.data.closed) {
      sendMessage(
        socket,
        createDaemonFailureMessage(createDiagnosticReport(started.error.diagnostics)),
      );
    }
    if (started.error.cleanup) {
      yield* superviseCleanup(started.error.cleanup.stop, options.diagnostics);
    }
    return;
  }

  socket.data.project = started.project;
  if (socket.data.closed || socket.data.stopRequested) {
    yield* superviseCleanup(started.project.stop, options.diagnostics);
    return;
  }
  if (!sendMessage(socket, createProjectStartedMessage(started.project.id, started.project.name))) {
    yield* superviseCleanup(started.project.stop, options.diagnostics);
    return;
  }
  socket.data.completion = options.runtime.runFork(
    observeProjectCompletion(socket, started.project, options.diagnostics),
  );
});

const observeProjectCompletion = Effect.fn("observeProjectCompletion")(function* (
  socket: Bun.ServerWebSocket<ControlData>,
  project: ManagedProject,
  diagnostics: DiagnosticSink,
) {
  const completion = yield* project.completed;
  if (completion.kind === "stopped") {
    if (!socket.data.stopRequested && !socket.data.closed) {
      sendMessage(socket, createProjectStoppedMessage());
    }
    return;
  }
  if (socket.data.stopRequested || socket.data.closed) {
    return;
  }
  const message = completion.result.success
    ? createProjectCompletedMessage(0)
    : createDaemonFailureMessage(createDiagnosticReport(completion.result.diagnostics));
  if (!sendMessage(socket, message)) {
    yield* superviseCleanup(project.stop, diagnostics);
  }
});

function enqueueControl(
  socket: Bun.ServerWebSocket<ControlData>,
  operation: Effect.Effect<void, never, ControlServices>,
  options: ControlServerOptions,
): void {
  const previous = socket.data.pending;
  const sequential = previous ? Fiber.await(previous).pipe(Effect.andThen(operation)) : operation;
  socket.data.pending = options.runtime.runFork(
    sequential.pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          const diagnostic = controlMessageDiagnostic(cause);
          options.diagnostics.report(diagnostic);
          sendFailure(socket, diagnostic);
        }),
      ),
    ),
  );
}

function interruptPending(data: ControlData, runtime: ControlRuntime): void {
  if (data.pending) {
    runtime.runFork(Fiber.interrupt(data.pending));
  }
}

function runHttp(
  options: ControlServerOptions,
  effect: Effect.Effect<Response, never, ControlServices>,
): Promise<Response> {
  return options.runtime.runPromise(effect).then(secure);
}

function projectFailureResponse(
  diagnostics: Parameters<typeof createDiagnosticReport>[0],
  status: number,
): Response {
  return secure(
    Response.json(createDiagnosticReport(diagnostics), {
      headers: { "cache-control": "no-store" },
      status,
    }),
  );
}

function projectFailureStatus(code: string | undefined): number {
  if (code === "SYD4100") {
    return 404;
  }
  if (code === "SYD4101" || code === "SYD4102") {
    return 409;
  }
  return code === "SYD2000" || code === "SYD2006" ? 400 : 500;
}

function invalidProjectRequest() {
  return [
    createDiagnostic({
      code: "SYD3016",
      help: "Update Stackyard so the CLI and daemon use the same protocol, then retry.",
      message: "The daemon received an invalid project request.",
    }),
  ] as const;
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
  if (socket.data.closed) {
    return false;
  }
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    socket.data.closed = true;
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
