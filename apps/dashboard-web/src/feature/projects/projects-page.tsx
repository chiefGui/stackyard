import * as stylex from "@stylexjs/stylex";
import { useQuery } from "@tanstack/react-query";

import type { ProjectList } from "@stackyard/protocol/projects";

import { colors, fonts, radii, spacing } from "../../styling/theme.stylex.ts";
import { ProjectServicesTable } from "./project-services-table.tsx";
import { projectsQueryOptions } from "./projects-query.ts";

export function ProjectsPage() {
  const { data, error, isPending } = useQuery(projectsQueryOptions);
  const connection = error ? "Unavailable" : data ? "Connected" : "Connecting";

  return (
    <main {...stylex.props(styles.main)}>
      <header {...stylex.props(styles.header)}>
        <div>
          <p {...stylex.props(styles.eyebrow)}>Projects</p>
          <h1 {...stylex.props(styles.heading)}>Stackyard</h1>
        </div>
        <p {...stylex.props(styles.connection)} aria-live="polite">
          <span
            {...stylex.props(
              styles.connectionIndicator,
              data && !error && styles.connectionIndicatorConnected,
              error && styles.connectionIndicatorError,
            )}
            aria-hidden="true"
          />
          {connection}
        </p>
      </header>
      <ProjectsContent error={error} isPending={isPending} projectList={data} />
    </main>
  );
}

function ProjectsContent({
  error,
  isPending,
  projectList,
}: {
  readonly error: Error | null;
  readonly isPending: boolean;
  readonly projectList: ProjectList | undefined;
}) {
  if (isPending) {
    return (
      <section
        {...stylex.props(styles.emptyState)}
        aria-busy="true"
        aria-label="Loading projects"
      />
    );
  }

  if (error && !projectList) {
    return (
      <section {...stylex.props(styles.emptyState)} aria-live="polite">
        <h2 {...stylex.props(styles.emptyHeading)}>Dashboard unavailable</h2>
        <p {...stylex.props(styles.emptyCopy)}>{error.message}</p>
      </section>
    );
  }

  if (!projectList?.projects.length) {
    return (
      <section {...stylex.props(styles.emptyState)} aria-live="polite">
        <h2 {...stylex.props(styles.emptyHeading)}>No projects yet</h2>
        <p {...stylex.props(styles.emptyCopy)}>
          Add one with <code {...stylex.props(styles.command)}>stackyard add .</code>.
        </p>
      </section>
    );
  }

  return <ProjectServicesTable projects={projectList.projects} />;
}

const styles = stylex.create({
  connection: {
    alignItems: "center",
    color: colors.textStatus,
    display: "flex",
    fontSize: 13,
    gap: spacing.small,
    marginBottom: "5px",
  },
  connectionIndicator: {
    backgroundColor: colors.textDisabled,
    borderRadius: "50%",
    height: 7,
    width: 7,
  },
  connectionIndicatorConnected: {
    backgroundColor: colors.successIndicator,
  },
  connectionIndicatorError: {
    backgroundColor: colors.dangerIndicator,
  },
  command: {
    fontFamily: fonts.mono,
    fontSize: "0.95em",
  },
  emptyCopy: {
    fontSize: 13,
  },
  emptyHeading: {
    color: colors.textHeading,
    fontSize: 16,
    fontWeight: 570,
    marginBottom: "7px",
  },
  emptyState: {
    backgroundColor: colors.surface,
    borderColor: colors.panelBorder,
    borderRadius: radii.panel,
    borderStyle: "solid",
    borderWidth: 1,
    color: colors.textMuted,
    display: "grid",
    minHeight: 240,
    placeContent: "center",
    textAlign: "center",
  },
  eyebrow: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: 650,
    letterSpacing: "0.09em",
    marginBottom: spacing.small,
    textTransform: "uppercase",
  },
  header: {
    alignItems: "flex-end",
    display: "flex",
    justifyContent: "space-between",
    marginBottom: spacing.large,
  },
  heading: {
    fontSize: "clamp(30px, 5vw, 42px)",
    fontWeight: 620,
    letterSpacing: "-0.04em",
  },
  main: {
    marginInline: "auto",
    paddingBlockEnd: "80px",
    paddingBlockStart: {
      "@media (max-width: 760px)": spacing.large,
      default: "56px",
    },
    width: {
      "@media (max-width: 760px)": "min(100% - 28px, 1180px)",
      default: "min(1180px, calc(100% - 48px))",
    },
  },
});
