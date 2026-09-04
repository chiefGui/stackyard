import { daemonUrl, ensureDaemon, type DaemonLocator } from "@stackyard/daemon/locator";
import {
  createDiagnostic,
  describeError,
  failure,
  reportDiagnostics,
  type Diagnostic,
  type DiagnosticSink,
  type Failure,
} from "@stackyard/diagnostics";
import { CanonicalPath, discoverProject } from "@stackyard/project-loader";
import { createStartProjectMessage, parseDaemonServerMessage } from "@stackyard/protocol";
import { Deferred, Effect, FileSystem, Option, Path, Ref, Scope } from "effect";
import { Argument } from "effect/unstable/cli";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import { Socket } from "effect/unstable/socket";

import { defineCliCommand, reportCommandFailure, type CliCommand } from "./cli.ts";
export interface RunCommandDependencies {
  readonly currentDirectory: string;
  readonly daemonEntrypoint: string;
  readonly dashboardWebDirectory: string;
  readonly diagnostics: DiagnosticSink;
  writeOutput(output: string): void;
}

export function createRunCommand(
  dependencies: RunCommandDependencies,
): CliCommand<
  | CanonicalPath
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
> {
  return defineCliCommand("run", "SYD2009", {
    args: {
      path: Argument.string("path").pipe(
        Argument.withDescription("Project directory"),
        Argument.optional,
        Argument.map(Option.getOrUndefined),
      ),
    },
    meta: {
      description: "Start a project and its dashboard",
    },
    run({ args }) {
      return reportCommandFailure(runProject(args.path, dependencies), dependencies.diagnostics);
    },
  });
}

const runProject = Effect.fn("runProject")(function* (
  path: string | undefined,
  dependencies: RunCommandDependencies,
): Effect.fn.Return<
  number,
  Failure,
  | CanonicalPath
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
> {
  const discovered = yield* discoverProject(path, dependencies.currentDirectory);
  const canonicalPath = yield* CanonicalPath;
  const root = yield* canonicalPath.resolve(discovered.root).pipe(
    Effect.mapError((error) =>
      failure(
        createDiagnostic({
          code: "SYD2006",
          help: "Verify that the project directory exists and is readable, then retry.",
          message: "The project directory could not be resolved.",
          notes: [describeError(error)],
        }),
      ),
    ),
  );

  const daemon = yield* ensureDaemon({
    daemonEntrypoint: dependencies.daemonEntrypoint,
    dashboardWebDirectory: dependencies.dashboardWebDirectory,
  });
  return yield* runSession(daemon, root, dependencies);
});

function runSession(
  locator: DaemonLocator,
  root: string,
  dependencies: RunCommandDependencies,
): Effect.Effect<number, never, HttpClient.HttpClient> {
  return HttpClient.HttpClient.use((client) =>
    runSessionWithClient(client, locator, root, dependencies).pipe(Effect.scoped),
  );
}

interface SessionOutcome {
  readonly diagnostics: readonly Diagnostic[];
  readonly exitCode: number;
}

const runSessionWithClient = Effect.fn("runSessionWithClient")(function* (
  client: HttpClient.HttpClient,
  locator: DaemonLocator,
  root: string,
  dependencies: RunCommandDependencies,
): Effect.fn.Return<number, never, Scope.Scope> {
  const controlUrl = new URL("api/v1/control", daemonUrl(locator));
  controlUrl.protocol = "ws:";
  const socket = yield* Socket.fromWebSocket(
    Effect.acquireRelease(
      Effect.try({
        try: () =>
          new WebSocket(controlUrl, {
            headers: { authorization: `Bearer ${locator.token}` },
          }),
        catch: (cause) =>
          new Socket.SocketError({
            reason: new Socket.SocketOpenError({ cause, kind: "Unknown" }),
          }),
      }),
      (webSocket) => Effect.sync(() => closeSocket(webSocket)),
    ),
    { openTimeout: "10 seconds" },
  );
  const write = yield* socket.writer;
  const completed = yield* Deferred.make<SessionOutcome>();
  const projectId = yield* Ref.make<string | undefined>(undefined);
  const started = yield* Deferred.make<void>();
  const wasStarted = yield* Ref.make(false);
  const complete = (outcome: SessionOutcome) => Deferred.succeed(completed, outcome);
  const failConnection = (note: string) =>
    complete({ diagnostics: [connectionDiagnostic(note)], exitCode: 1 });

  const handleMessage = Effect.fn("runSession.handleMessage")(function* (payload: string) {
    const decoded = yield* Effect.try({
      try: () => JSON.parse(payload) as unknown,
      catch: () => undefined,
    }).pipe(Effect.option);
    if (Option.isNone(decoded)) {
      yield* failConnection("The daemon sent malformed data.");
      return;
    }

    const message = parseDaemonServerMessage(decoded.value);
    if (!message.success) {
      yield* complete({ diagnostics: message.diagnostics, exitCode: 1 });
      return;
    }

    if (message.output.kind === "started") {
      const projectName = message.output.projectName;
      yield* Ref.set(projectId, message.output.projectId);
      yield* Ref.set(wasStarted, true);
      yield* Deferred.succeed(started, undefined);
      yield* Effect.sync(() =>
        dependencies.writeOutput(`${projectName} is running. Dashboard: ${daemonUrl(locator)}\n`),
      );
      return;
    }
    if (message.output.kind === "failed") {
      yield* complete({ diagnostics: message.output.report.diagnostics, exitCode: 1 });
      return;
    }
    if (message.output.kind === "completed") {
      yield* complete({ diagnostics: [], exitCode: message.output.exitCode });
      return;
    }
    yield* complete({ diagnostics: [], exitCode: 0 });
  });

  yield* socket
    .runString(handleMessage, {
      onOpen: write(
        JSON.stringify(createStartProjectMessage(root, serviceEnvironment(process.env))),
      ).pipe(
        Effect.catch(() => failConnection("The start request could not be sent.")),
        Effect.asVoid,
      ),
    })
    .pipe(
      Effect.catch((error) =>
        Ref.get(wasStarted).pipe(
          Effect.flatMap((active) => failConnection(socketFailureNote(error, active))),
        ),
      ),
      Effect.forkScoped,
    );

  const startup = yield* Deferred.await(started).pipe(
    Effect.as({ kind: "started" } as const),
    Effect.raceFirst(
      Deferred.await(completed).pipe(
        Effect.map((outcome) => ({ kind: "completed", outcome }) as const),
      ),
    ),
    Effect.timeoutOption("10 seconds"),
  );
  const outcome = yield* Option.match(startup, {
    onNone: () =>
      Effect.succeed<SessionOutcome>({
        diagnostics: [
          createDiagnostic({
            code: "SYD2011",
            help: "Check the service commands and Stackyard daemon, then retry.",
            message: "The daemon did not start the project within ten seconds.",
          }),
        ],
        exitCode: 1,
      }),
    onSome: (state) =>
      state.kind === "completed" ? Effect.succeed(state.outcome) : Deferred.await(completed),
  }).pipe(
    Effect.onInterrupt(() =>
      Ref.get(projectId).pipe(
        Effect.flatMap((id) =>
          id
            ? stopAttachedProject(client, locator, id).pipe(
                Effect.catch((failed) =>
                  Effect.sync(() =>
                    reportDiagnostics(dependencies.diagnostics, failed.diagnostics),
                  ),
                ),
              )
            : Effect.void,
        ),
      ),
    ),
  );
  yield* Effect.sync(() => reportDiagnostics(dependencies.diagnostics, outcome.diagnostics));
  return outcome.exitCode;
});

const stopAttachedProject = Effect.fn("stopAttachedProject")(function* (
  client: HttpClient.HttpClient,
  locator: DaemonLocator,
  projectId: string,
): Effect.fn.Return<void, Failure> {
  const request = yield* HttpClientRequest.post(
    new URL("api/v1/projects/stop", daemonUrl(locator)),
  ).pipe(
    HttpClientRequest.setHeader("authorization", `Bearer ${locator.token}`),
    HttpClientRequest.bodyJson({ target: projectId }),
    Effect.mapError((error) =>
      failure(connectionDiagnostic(`The project stop request failed: ${describeError(error)}`)),
    ),
  );
  const response = yield* client.execute(request).pipe(
    Effect.mapError((error) =>
      failure(connectionDiagnostic(`The project stop request failed: ${describeError(error)}`)),
    ),
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () =>
        Effect.fail(failure(connectionDiagnostic("The project stop request timed out."))),
    }),
  );
  if (response.status < 200 || response.status >= 300) {
    return yield* Effect.fail(
      failure(connectionDiagnostic(`The project stop request returned HTTP ${response.status}.`)),
    );
  }
  return yield* Effect.void;
});

function closeSocket(socket: WebSocket): void {
  try {
    if (socket.readyState < WebSocket.CLOSING) {
      socket.close();
    }
  } catch {
    // The peer may have closed the socket between the state check and close.
  }
}

function socketFailureNote(error: Socket.SocketError, started: boolean): string {
  if (error.reason._tag !== "SocketCloseError") {
    return "The control connection failed.";
  }
  return started
    ? "The daemon connection closed while the project was running."
    : "The daemon closed the connection before starting the project.";
}

function serviceEnvironment(environment: NodeJS.ProcessEnv): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(environment).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && !isStackyardVariable(entry[0]),
      ),
    ),
  );
}

function isStackyardVariable(name: string): boolean {
  let comparable = name;
  if (process.platform === "win32") {
    comparable = name.toUpperCase();
  }
  return comparable.startsWith("STACKYARD_");
}

function connectionDiagnostic(note: string): Diagnostic {
  return createDiagnostic({
    code: "SYD2010",
    help: "Run the command again. If the problem persists, stop the stale Stackyard daemon.",
    message: "The Stackyard daemon connection was lost.",
    notes: [note],
  });
}
