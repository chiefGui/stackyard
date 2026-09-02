import { daemonUrl, ensureDaemon, findDaemon, type DaemonLocator } from "@stackyard/daemon/locator";
import {
  createDiagnostic,
  failure,
  isDiagnosticReport,
  success,
  type Result,
} from "@stackyard/diagnostics";
import {
  parseProject,
  parseProjectList,
  type Project,
  type ProjectList,
} from "@stackyard/protocol";

export interface ProjectClient {
  add(path: string): Promise<Result<Project>>;
  list(): Promise<Result<ProjectList>>;
  remove(target: string): Promise<Result<Project>>;
  stop(target: string): Promise<Result<StopProjectOutput>>;
}

export type StopProjectOutput =
  | { readonly kind: "daemon-not-running" }
  | { readonly kind: "stopped"; readonly project: Project };

export interface DaemonProjectClientOptions {
  readonly daemonEntrypoint: string;
  readonly dashboardWebDirectory: string;
}

export class DaemonProjectClient implements ProjectClient {
  readonly #options: DaemonProjectClientOptions;
  #daemon: Promise<Result<DaemonLocator>> | undefined;

  constructor(options: DaemonProjectClientOptions) {
    this.#options = options;
  }

  add(path: string): Promise<Result<Project>> {
    return this.#requestProject("api/v1/projects", "POST", { path });
  }

  async list(): Promise<Result<ProjectList>> {
    const response = await this.#request("api/v1/projects", "GET");
    if (!response.success) {
      return response;
    }
    return parseProjectList(response.output);
  }

  remove(target: string): Promise<Result<Project>> {
    return this.#requestProject("api/v1/projects", "DELETE", { target });
  }

  async stop(target: string): Promise<Result<StopProjectOutput>> {
    const daemon = await findDaemon();
    if (!daemon.success) {
      return daemon;
    }
    if (!daemon.output) {
      return success(Object.freeze({ kind: "daemon-not-running" }));
    }
    const stopped = await this.#parseProjectResponse(
      this.#send(daemon.output, "api/v1/projects/stop", "POST", { target }),
    );
    return stopped.success
      ? success(Object.freeze({ kind: "stopped", project: stopped.output }))
      : stopped;
  }

  async #requestProject(
    path: string,
    method: "DELETE" | "POST",
    body: Readonly<Record<string, string>>,
  ): Promise<Result<Project>> {
    return this.#parseProjectResponse(this.#request(path, method, body));
  }

  async #parseProjectResponse(responsePromise: Promise<Result<unknown>>): Promise<Result<Project>> {
    const response = await responsePromise;
    return response.success ? parseProject(response.output) : response;
  }

  async #request(
    path: string,
    method: "DELETE" | "GET" | "POST",
    body?: Readonly<Record<string, string>>,
  ): Promise<Result<unknown>> {
    this.#daemon ??= ensureDaemon(this.#options);
    const daemon = await this.#daemon;
    if (!daemon.success) {
      return daemon;
    }

    return this.#send(daemon.output, path, method, body);
  }

  async #send(
    daemon: DaemonLocator,
    path: string,
    method: "DELETE" | "GET" | "POST",
    body?: Readonly<Record<string, string>>,
  ): Promise<Result<unknown>> {
    try {
      const response = await fetch(new URL(path, daemonUrl(daemon)), {
        ...(body ? { body: JSON.stringify(body) } : {}),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${daemon.token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        method,
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return connectionFailure(
          response.ok
            ? `The daemon returned HTTP ${response.status} with invalid JSON.`
            : `The daemon returned HTTP ${response.status}.`,
        );
      }
      if (response.ok) {
        return success(value);
      }
      if (isDiagnosticReport(value) && value.diagnostics.length > 0) {
        const [first, ...remaining] = value.diagnostics;
        if (first) {
          return failure(first, ...remaining);
        }
      }
      return connectionFailure(`The daemon returned HTTP ${response.status}.`);
    } catch (error) {
      return connectionFailure(error instanceof Error ? error.message : String(error));
    }
  }
}

function connectionFailure<T>(note: string): Result<T> {
  return failure(
    createDiagnostic({
      code: "SYD2012",
      help: "Run the command again. If the problem persists, stop the stale Stackyard daemon.",
      message: "The project request failed.",
      notes: [note],
    }),
  );
}
