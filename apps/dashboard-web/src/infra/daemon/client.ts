import { parseProjectList, type ProjectList } from "@stackyard/protocol/projects";

type Requester = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ListProjectsOptions {
  readonly signal?: AbortSignal;
}

export interface DaemonClient {
  listProjects(options?: ListProjectsOptions): Promise<ProjectList>;
}

export function createDaemonClient(
  request: Requester = (input, init) => globalThis.fetch(input, init),
): DaemonClient {
  return {
    async listProjects(options) {
      let response: Response;
      try {
        response = await request("/api/v1/projects", {
          cache: "no-store",
          ...(options?.signal ? { signal: options.signal } : {}),
        });
      } catch (error) {
        if (options?.signal?.aborted) {
          throw error;
        }
        throw new Error("The daemon did not respond.", { cause: error });
      }
      if (!response.ok) {
        throw new Error(`The daemon returned HTTP ${response.status}.`);
      }

      let input: unknown;
      try {
        input = await response.json();
      } catch {
        throw new Error("The daemon returned invalid JSON.");
      }

      const parsed = parseProjectList(input);
      if (!parsed.success) {
        throw new Error(parsed.diagnostics[0].message);
      }
      return parsed.output;
    },
  };
}

export const daemonClient = createDaemonClient();
