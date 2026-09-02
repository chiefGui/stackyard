import * as stylex from "@stylexjs/stylex";
import { useQuery } from "@tanstack/react-query";

import type { ProjectList } from "@stackyard/protocol/projects";

import { colors, fonts, radii, spacing } from "../../styling/theme.stylex.ts";
import { typography } from "../../styling/typography.ts";
import { ProjectCards } from "./project-cards.tsx";
import { projectsQueryOptions } from "./projects-query.ts";

export function ProjectsPage() {
  const { data, error, isPending } = useQuery(projectsQueryOptions);
  const connection = error ? "Unavailable" : data ? "Connected" : "Connecting";

  return (
    <main {...stylex.props(styles.main)}>
      <header {...stylex.props(styles.header)} aria-label="Dashboard status">
        <p {...stylex.props(styles.connection, typography.label)} aria-live="polite">
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
        <h2 {...stylex.props(styles.emptyHeading, typography.subtitle)}>Dashboard unavailable</h2>
        <p {...stylex.props(typography.body)}>{error.message}</p>
      </section>
    );
  }

  if (!projectList?.projects.length) {
    return (
      <section {...stylex.props(styles.emptyState)} aria-live="polite">
        <h2 {...stylex.props(styles.emptyHeading, typography.subtitle)}>No projects yet</h2>
        <p {...stylex.props(typography.body)}>
          Add one with <code {...stylex.props(styles.command)}>stackyard add .</code>.
        </p>
      </section>
    );
  }

  return <ProjectCards projects={projectList.projects} />;
}

const styles = stylex.create({
  connection: {
    alignItems: "center",
    color: colors.textStatus,
    display: "flex",
    gap: spacing.small,
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
  },
  emptyHeading: {
    color: colors.textHeading,
    marginBottom: spacing.small,
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
  header: {
    alignItems: "center",
    display: "flex",
    justifyContent: "flex-end",
    marginBottom: spacing.large,
    minHeight: spacing.xLarge,
  },
  main: {
    marginInline: "auto",
    paddingBlockEnd: spacing.xxxLarge,
    paddingBlockStart: {
      "@media (max-width: 760px)": spacing.large,
      default: spacing.xxLarge,
    },
    width: {
      "@media (max-width: 760px)": "min(100% - 28px, 1180px)",
      default: "min(1180px, calc(100% - 48px))",
    },
  },
});
