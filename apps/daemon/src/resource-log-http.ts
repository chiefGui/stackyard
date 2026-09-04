import {
  ProjectManager,
  type RuntimeProject,
  type ResourceLogSnapshot,
  type ResourceLogSource,
} from "@stackyard/control-plane";
import { createDiagnosticReport } from "@stackyard/diagnostics";
import { createProjectList } from "@stackyard/protocol/projects";
import { createResourceLogBatch, type ResourceLogBatch } from "@stackyard/protocol/resource-logs";
import { Effect } from "effect";

/* oxlint-disable eslint/no-await-in-loop -- Each pull waits for the next revision in sequence. */

const entriesPerBatch = 256;
const encoder = new TextEncoder();

export interface ResourceLogHttpOptions {
  readonly token: string;
  disableRequestTimeout(): void;
  isShuttingDown(): boolean;
}

export const handleResourceLogHttpRequest = Effect.fn("handleResourceLogHttpRequest")(function* (
  request: Request,
  url: URL,
  options: ResourceLogHttpOptions,
): Effect.fn.Return<Response | undefined, never, ProjectManager> {
  const manager = yield* ProjectManager;
  if (url.pathname === "/api/v1/projects/recent") {
    if (!isAuthorized(request, options.token)) {
      return unauthorizedResponse();
    }
    if (options.isShuttingDown()) {
      return new Response("Daemon is shutting down.", { status: 503 });
    }
    if (url.search.length > 0) {
      return new Response("Query parameters are not supported.", { status: 400 });
    }
    return Response.json(
      createProjectList({
        projects: (yield* manager.listRecentProjects).projects.map(recentProject),
      }),
      {
        headers: { "cache-control": "no-store" },
      },
    );
  }

  const target = parseResourceLogRequest(url);
  if (!target) {
    return undefined;
  }
  if (!isAuthorized(request, options.token)) {
    return unauthorizedResponse();
  }
  if (options.isShuttingDown()) {
    return new Response("Daemon is shutting down.", { status: 503 });
  }
  if (target === "invalid") {
    return new Response("Resource log request is invalid.", { status: 400 });
  }

  const source = yield* manager.getResourceLogs(target.projectId, target.resourceName);
  if (!source) {
    return new Response("Resource log feed not found.", { status: 404 });
  }
  if (target.after > source.snapshot({ after: target.after, limit: 1 }).latestCursor) {
    return new Response("Resource log cursor is ahead of this feed.", { status: 400 });
  }

  options.disableRequestTimeout();
  return createResourceLogResponse({
    after: target.after,
    onClose: noop,
    projectId: target.projectId,
    resourceName: target.resourceName,
    signal: request.signal,
    source,
  });
});

function recentProject(project: RuntimeProject) {
  return {
    id: project.id,
    name: project.name,
    restartRequired: false,
    root: project.root,
    services: project.services,
    state: project.services.some(({ state }) => state === "failed")
      ? ("needs-attention" as const)
      : ("stopped" as const),
  };
}

export interface ResourceLogResponseOptions {
  readonly after: number;
  readonly projectId: string;
  readonly resourceName: string;
  readonly signal: AbortSignal;
  readonly source: ResourceLogSource;
  onClose(): void;
}

export function createResourceLogResponse(options: ResourceLogResponseOptions): Response {
  const cancellation = new AbortController();
  let cursor = options.after;
  let finished = false;
  let initialized = false;

  const finish = (): void => {
    if (finished) {
      return;
    }
    finished = true;
    options.signal.removeEventListener("abort", abort);
    options.onClose();
  };
  const abort = (): void => {
    cancellation.abort();
    finish();
  };
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) {
    abort();
  }

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (!cancellation.signal.aborted) {
          const snapshot = options.source.snapshot({ after: cursor, limit: entriesPerBatch });
          if (shouldSend(snapshot, initialized)) {
            cursor = snapshot.nextCursor;
            initialized = true;
            controller.enqueue(
              encoder.encode(
                `${JSON.stringify(createBatch(snapshot, cursor, options.projectId, options.resourceName))}\n`,
              ),
            );

            if (!snapshot.hasMore && snapshot.status !== "live") {
              controller.close();
              finish();
            }
            return;
          }

          await Effect.runPromise(options.source.waitForChange(snapshot.revision), {
            signal: cancellation.signal,
          });
        }
        controller.close();
      } catch (error) {
        if (cancellation.signal.aborted) {
          controller.close();
        } else {
          controller.error(error);
        }
        finish();
      }
    },
    cancel() {
      cancellation.abort();
      finish();
    },
  });

  return new Response(body, {
    headers: {
      "cache-control": "no-store",
      "content-type": "application/x-ndjson; charset=utf-8",
    },
  });
}

function shouldSend(snapshot: ResourceLogSnapshot, initialized: boolean): boolean {
  return (
    !initialized ||
    snapshot.entries.length > 0 ||
    snapshot.droppedEntries > 0 ||
    snapshot.status !== "live"
  );
}

function createBatch(
  snapshot: ResourceLogSnapshot,
  cursor: number,
  projectId: string,
  resourceName: string,
): ResourceLogBatch {
  const input = {
    cursor,
    droppedEntries: snapshot.droppedEntries,
    entries: snapshot.entries,
    latestCursor: snapshot.latestCursor,
    projectId,
    resourceName,
    retainedFrom: snapshot.retainedFrom,
  };
  if (snapshot.status !== "failed") {
    return createResourceLogBatch({ ...input, status: snapshot.status });
  }
  if (!snapshot.completion || snapshot.completion.success) {
    throw new Error("A failed resource log feed has no failure diagnostic.");
  }
  return createResourceLogBatch({
    ...input,
    failure: createDiagnosticReport(snapshot.completion.diagnostics),
    status: "failed",
  });
}

interface ResourceLogRequest {
  readonly after: number;
  readonly projectId: string;
  readonly resourceName: string;
}

function parseResourceLogRequest(url: URL): ResourceLogRequest | "invalid" | undefined {
  const match = /^\/api\/v1\/projects\/([^/]+)\/resources\/([^/]+)\/logs$/.exec(url.pathname);
  if (!match) {
    return undefined;
  }
  if (
    [...url.searchParams.keys()].some((key) => key !== "after") ||
    url.searchParams.getAll("after").length > 1
  ) {
    return "invalid";
  }

  const rawAfter = url.searchParams.get("after");
  if (rawAfter !== null && !/^(0|[1-9]\d*)$/.test(rawAfter)) {
    return "invalid";
  }
  const after = rawAfter === null ? 0 : Number(rawAfter);
  if (!Number.isSafeInteger(after)) {
    return "invalid";
  }

  try {
    const projectId = decodeURIComponent(match[1] ?? "");
    const resourceName = decodeURIComponent(match[2] ?? "");
    if (projectId.length === 0 || resourceName.length === 0) {
      return "invalid";
    }
    return { after, projectId, resourceName };
  } catch {
    return "invalid";
  }
}

function isAuthorized(request: Request, token: string): boolean {
  return request.headers.get("authorization") === `Bearer ${token}`;
}

function unauthorizedResponse(): Response {
  return new Response("Unauthorized.", {
    headers: { "www-authenticate": "Bearer" },
    status: 401,
  });
}

function noop(): void {}
