import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  parseRuntimeSnapshot,
  type RuntimeResource,
  type RuntimeSnapshot,
} from "@stackyard/protocol/snapshot";

// oxlint-disable-next-line import/no-unassigned-import -- Vite injects stylesheet imports.
import "./main.css";

const refreshMilliseconds = 1_000;

function Dashboard() {
  const { error, snapshot } = useRuntimeSnapshot();
  const connection = error ? "Unavailable" : snapshot ? "Connected" : "Connecting";
  const resourceCount =
    snapshot?.projects.reduce((total, project) => total + project.resources.length, 0) ?? 0;

  return (
    <main>
      <header className="page-header">
        <div>
          <p className="eyebrow">Local runtime</p>
          <h1>Stackyard</h1>
        </div>
        <p className={`connection ${error ? "connection-error" : ""}`}>
          <span aria-hidden="true" />
          {connection}
        </p>
      </header>

      {error && !snapshot ? (
        <section className="empty-state" aria-live="polite">
          <h2>Dashboard unavailable</h2>
          <p>{error}</p>
        </section>
      ) : resourceCount === 0 ? (
        <section className="empty-state" aria-live="polite">
          <h2>No projects running</h2>
          <p>Start one with stackyard run.</p>
        </section>
      ) : (
        <section className="resource-panel" aria-label="Running services">
          <table>
            <thead>
              <tr>
                <th>Project</th>
                <th>Service</th>
                <th>Status</th>
                <th>Endpoint</th>
              </tr>
            </thead>
            <tbody>
              {snapshot?.projects.flatMap((project) =>
                project.resources.map((resource) => (
                  <ResourceRow
                    key={`${project.id}:${resource.name}`}
                    project={project.name}
                    resource={resource}
                  />
                )),
              )}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}

function ResourceRow({ project, resource }: { project: string; resource: RuntimeResource }) {
  return (
    <tr>
      <td className="project-name">{project}</td>
      <td className="service-name">{resource.name}</td>
      <td>
        <span className={`state state-${resource.state}`}>{resource.state}</span>
      </td>
      <td>
        <div className="endpoints">
          {resource.endpoints.length === 0 ? (
            <span className="muted">—</span>
          ) : (
            resource.endpoints.map((endpoint) => (
              <a href={endpoint.url} key={endpoint.name} target="_blank" rel="noreferrer">
                {endpoint.name}
                <span>{endpoint.url}</span>
              </a>
            ))
          )}
        </div>
      </td>
    </tr>
  );
}

function useRuntimeSnapshot(): {
  readonly error: string | undefined;
  readonly snapshot: RuntimeSnapshot | undefined;
} {
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    const refresh = async (): Promise<void> => {
      try {
        const response = await fetch("/api/v1/snapshot", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`The daemon returned HTTP ${response.status}.`);
        }

        const parsed = parseRuntimeSnapshot(await response.json());
        if (!parsed.success) {
          throw new Error(parsed.diagnostics[0].message);
        }

        setSnapshot(parsed.output);
        setError(undefined);
      } catch (caught) {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : "The daemon did not respond.");
        }
      } finally {
        if (!controller.signal.aborted) {
          timer = setTimeout(refresh, refreshMilliseconds);
        }
      }
    };

    void refresh();
    return () => {
      controller.abort();
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, []);

  return { error, snapshot };
}

const root = document.getElementById("root");
if (!root) {
  throw new Error("Dashboard root element is missing.");
}

createRoot(root).render(
  <StrictMode>
    <Dashboard />
  </StrictMode>,
);
