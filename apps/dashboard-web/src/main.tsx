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
  let connection = "Connecting";
  let connectionClassName = "connection";
  if (error) {
    connection = "Unavailable";
    connectionClassName = "connection connection-error";
  } else if (snapshot) {
    connection = "Connected";
  }

  return (
    <main>
      <header className="page-header">
        <div>
          <p className="eyebrow">Local runtime</p>
          <h1>Stackyard</h1>
        </div>
        <p className={connectionClassName}>
          <span aria-hidden="true" />
          {connection}
        </p>
      </header>
      <DashboardContent error={error} snapshot={snapshot} />
    </main>
  );
}

function DashboardContent({
  error,
  snapshot,
}: {
  readonly error: string | undefined;
  readonly snapshot: RuntimeSnapshot | undefined;
}) {
  if (!snapshot && !error) {
    return <section className="empty-state" aria-busy="true" aria-label="Loading runtime state" />;
  }

  if (error && !snapshot) {
    return (
      <section className="empty-state" aria-live="polite">
        <h2>Dashboard unavailable</h2>
        <p>{error}</p>
      </section>
    );
  }

  const resourceCount =
    snapshot?.projects.reduce((total, project) => total + project.resources.length, 0) ?? 0;
  if (resourceCount === 0) {
    return (
      <section className="empty-state" aria-live="polite">
        <h2>No projects running</h2>
        <p>Start one with stackyard run.</p>
      </section>
    );
  }

  return (
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
        <ResourceEndpoints resource={resource} />
      </td>
    </tr>
  );
}

function ResourceEndpoints({ resource }: { readonly resource: RuntimeResource }) {
  if (resource.endpoints.length === 0) {
    return <span className="muted">None</span>;
  }

  return (
    <div className="endpoints">
      {resource.endpoints.map((endpoint) => (
        <a href={endpoint.url} key={endpoint.name} target="_blank" rel="noreferrer">
          {endpoint.name}
          <span>{endpoint.url}</span>
        </a>
      ))}
    </div>
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
          let message = "The daemon did not respond.";
          if (caught instanceof Error) {
            message = caught.message;
          }
          setError(message);
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
