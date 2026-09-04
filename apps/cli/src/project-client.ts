import { daemonUrl, ensureDaemon, findDaemon, type DaemonLocator } from "@stackyard/daemon/locator";
import {
  createDiagnostic,
  describeError,
  failure,
  isDiagnosticReport,
  type Failure,
  type Result,
} from "@stackyard/diagnostics";
import {
  parseProject,
  parseProjectList,
  type Project,
  type ProjectList,
} from "@stackyard/protocol";
import { Context, Effect, FileSystem, Layer, Path } from "effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

export class ProjectClient extends Context.Service<
  ProjectClient,
  {
    readonly add: (path: string) => Effect.Effect<Project, Failure>;
    readonly list: Effect.Effect<ProjectList, Failure>;
    readonly remove: (target: string) => Effect.Effect<Project, Failure>;
    readonly stop: (target: string) => Effect.Effect<StopProjectOutput, Failure>;
  }
>()("stackyard/cli/ProjectClient") {}

export type StopProjectOutput =
  | { readonly kind: "daemon-not-running" }
  | { readonly kind: "stopped"; readonly project: Project };

export interface DaemonProjectClientOptions {
  readonly daemonEntrypoint: string;
  readonly dashboardWebDirectory: string;
}

export function makeDaemonProjectClientLayer(
  options: DaemonProjectClientOptions,
): Layer.Layer<
  ProjectClient,
  never,
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
> {
  return Layer.effect(
    ProjectClient,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const daemon = yield* Effect.cached(
        ensureDaemon(options).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provideService(Path.Path, pathService),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      );

      const send = (
        locator: DaemonLocator,
        path: string,
        method: "DELETE" | "GET" | "POST",
        body?: Readonly<Record<string, string>>,
      ): Effect.Effect<unknown, Failure> =>
        makeRequest(locator, path, method, body).pipe(
          Effect.flatMap(client.execute),
          Effect.flatMap((response) =>
            response.text.pipe(Effect.map((text) => ({ response, text }))),
          ),
          Effect.mapError((error) => connectionFailure(describeError(error))),
          Effect.timeoutOrElse({
            duration: "15 seconds",
            orElse: () => Effect.fail(connectionFailure("The request timed out after 15 seconds.")),
          }),
          Effect.flatMap(({ response, text }) => parseResponse(response, text)),
        );

      const request = (
        path: string,
        method: "DELETE" | "GET" | "POST",
        body?: Readonly<Record<string, string>>,
      ): Effect.Effect<unknown, Failure> =>
        daemon.pipe(Effect.flatMap((locator) => send(locator, path, method, body)));

      const requestProject = (
        path: string,
        method: "DELETE" | "POST",
        body: Readonly<Record<string, string>>,
      ): Effect.Effect<Project, Failure> =>
        request(path, method, body).pipe(
          Effect.flatMap((value) => fromResult(parseProject(value))),
        );

      return ProjectClient.of({
        add: (path) => requestProject("api/v1/projects", "POST", { path }),
        list: request("api/v1/projects", "GET").pipe(
          Effect.flatMap((value) => fromResult(parseProjectList(value))),
        ),
        remove: (target) => requestProject("api/v1/projects", "DELETE", { target }),
        stop: (target) =>
          findDaemon().pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(HttpClient.HttpClient, client),
            Effect.provideService(Path.Path, pathService),
            Effect.flatMap((locator) =>
              locator
                ? send(locator, "api/v1/projects/stop", "POST", { target }).pipe(
                    Effect.flatMap((value) => fromResult(parseProject(value))),
                    Effect.map((project): StopProjectOutput =>
                      Object.freeze({ kind: "stopped", project }),
                    ),
                  )
                : Effect.succeed<StopProjectOutput>(Object.freeze({ kind: "daemon-not-running" })),
            ),
          ),
      });
    }),
  );
}

function makeRequest(
  locator: DaemonLocator,
  path: string,
  method: "DELETE" | "GET" | "POST",
  body?: Readonly<Record<string, string>>,
) {
  const request = HttpClientRequest.make(method)(new URL(path, daemonUrl(locator))).pipe(
    HttpClientRequest.setHeaders({
      accept: "application/json",
      authorization: `Bearer ${locator.token}`,
    }),
  );
  return body ? HttpClientRequest.bodyJson(request, body) : Effect.succeed(request);
}

function parseResponse(
  response: HttpClientResponse.HttpClientResponse,
  text: string,
): Effect.Effect<unknown, Failure> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return Effect.fail(
      connectionFailure(
        response.status >= 200 && response.status < 300
          ? `The daemon returned HTTP ${response.status} with invalid JSON.`
          : `The daemon returned HTTP ${response.status}.`,
      ),
    );
  }
  if (response.status >= 200 && response.status < 300) {
    return Effect.succeed(value);
  }
  if (isDiagnosticReport(value) && value.diagnostics.length > 0) {
    const [first, ...remaining] = value.diagnostics;
    if (first) {
      return Effect.fail(failure(first, ...remaining));
    }
  }
  return Effect.fail(connectionFailure(`The daemon returned HTTP ${response.status}.`));
}

function fromResult<A>(result: Result<A>): Effect.Effect<A, Failure> {
  return result.success ? Effect.succeed(result.output) : Effect.fail(result);
}

function connectionFailure(note: string): Failure {
  return failure(
    createDiagnostic({
      code: "SYD2012",
      help: "Run the command again. If the problem persists, stop the stale Stackyard daemon.",
      message: "The project request failed.",
      notes: [note],
    }),
  );
}
