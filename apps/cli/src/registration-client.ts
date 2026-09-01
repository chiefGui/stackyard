import { daemonUrl, ensureDaemon, type DaemonLocator } from "@stackyard/daemon/locator";
import {
  createDiagnostic,
  failure,
  isDiagnosticReport,
  success,
  type Result,
} from "@stackyard/diagnostics";
import {
  parseRegisteredProject,
  parseRegisteredProjectList,
  type RegisteredProject,
  type RegisteredProjectList,
} from "@stackyard/protocol";

export interface RegistrationClient {
  add(path: string): Promise<Result<RegisteredProject>>;
  list(): Promise<Result<RegisteredProjectList>>;
  remove(target: string): Promise<Result<RegisteredProject>>;
}

export interface DaemonRegistrationClientOptions {
  readonly daemonEntrypoint: string;
  readonly dashboardWebDirectory: string;
}

export class DaemonRegistrationClient implements RegistrationClient {
  readonly #options: DaemonRegistrationClientOptions;
  #daemon: Promise<Result<DaemonLocator>> | undefined;

  constructor(options: DaemonRegistrationClientOptions) {
    this.#options = options;
  }

  add(path: string): Promise<Result<RegisteredProject>> {
    return this.#requestProject("POST", { path });
  }

  async list(): Promise<Result<RegisteredProjectList>> {
    const response = await this.#request("GET");
    if (!response.success) {
      return response;
    }
    return parseRegisteredProjectList(response.output);
  }

  remove(target: string): Promise<Result<RegisteredProject>> {
    return this.#requestProject("DELETE", { target });
  }

  async #requestProject(
    method: "DELETE" | "POST",
    body: Readonly<Record<string, string>>,
  ): Promise<Result<RegisteredProject>> {
    const response = await this.#request(method, body);
    if (!response.success) {
      return response;
    }
    return parseRegisteredProject(response.output);
  }

  async #request(
    method: "DELETE" | "GET" | "POST",
    body?: Readonly<Record<string, string>>,
  ): Promise<Result<unknown>> {
    this.#daemon ??= ensureDaemon(this.#options);
    const daemon = await this.#daemon;
    if (!daemon.success) {
      return daemon;
    }

    try {
      const response = await fetch(new URL("api/v1/registrations", daemonUrl(daemon.output)), {
        ...(body ? { body: JSON.stringify(body) } : {}),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${daemon.output.token}`,
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
      message: "The project registry request failed.",
      notes: [note],
    }),
  );
}
