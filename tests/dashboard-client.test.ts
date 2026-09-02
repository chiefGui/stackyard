import { expect, test } from "bun:test";

import { createDaemonClient } from "../apps/dashboard-web/src/infra/daemon/client.ts";
import { projectsQueryOptions } from "../apps/dashboard-web/src/feature/projects/projects-query.ts";

test("projects query preserves local daemon polling semantics", () => {
  expect(projectsQueryOptions.networkMode).toBe("always");
  expect(projectsQueryOptions.refetchInterval).toBe(1_000);
  expect(projectsQueryOptions.refetchIntervalInBackground).toBeTrue();
  expect(projectsQueryOptions.retry).toBeFalse();
});

test("daemon client requests and validates the durable project list", async () => {
  const cancellation = new AbortController();
  const requests: Array<{ input: unknown; init: RequestInit | undefined }> = [];
  const client = createDaemonClient((input, init) => {
    requests.push({ input, init });
    return Promise.resolve(
      Response.json({
        projects: [
          {
            id: "project-1",
            name: "demo",
            restartRequired: false,
            root: "C:/project",
            services: [
              {
                endpoints: [{ name: "http", url: "http://127.0.0.1:4000" }],
                name: "api",
                state: "running",
              },
            ],
            state: "running",
          },
        ],
        schemaVersion: 1,
      }),
    );
  });

  const projectList = await client.listProjects({ signal: cancellation.signal });

  expect(projectList.projects[0]?.name).toBe("demo");
  expect(requests).toHaveLength(1);
  expect(requests[0]?.input).toBe("/api/v1/projects");
  expect(requests[0]?.init).toMatchObject({ cache: "no-store", signal: cancellation.signal });
});

test("daemon client reports HTTP, JSON, and protocol failures", async () => {
  const disconnected = createDaemonClient(() => Promise.reject(new Error("Connection refused")));
  expect(disconnected.listProjects()).rejects.toThrow("The daemon did not respond.");

  const unavailable = createDaemonClient(() =>
    Promise.resolve(new Response("Unavailable", { status: 503 })),
  );
  expect(unavailable.listProjects()).rejects.toThrow("The daemon returned HTTP 503.");

  const invalidJson = createDaemonClient(() => Promise.resolve(new Response("{")));
  expect(invalidJson.listProjects()).rejects.toThrow("The daemon returned invalid JSON.");

  const invalidProtocol = createDaemonClient(() =>
    Promise.resolve(Response.json({ projects: [] })),
  );
  expect(invalidProtocol.listProjects()).rejects.toThrow("Project list is invalid.");
});
