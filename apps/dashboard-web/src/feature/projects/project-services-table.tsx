import * as stylex from "@stylexjs/stylex";
import { Fragment } from "react";

import type { Project, Service } from "@stackyard/protocol/projects";

import { colors, fonts, radii, spacing } from "../../styling/theme.stylex.ts";

export function ProjectServicesTable({ projects }: { readonly projects: readonly Project[] }) {
  return (
    <section {...stylex.props(styles.panel)} aria-label="Projects and services">
      <table {...stylex.props(styles.table)}>
        <thead>
          <tr>
            <th {...stylex.props(styles.cell, styles.headerCell)}>Project</th>
            <th {...stylex.props(styles.cell, styles.headerCell)}>Service</th>
            <th {...stylex.props(styles.cell, styles.headerCell)}>Status</th>
            <th {...stylex.props(styles.cell, styles.headerCell)}>Endpoint</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((project, projectIndex) => {
            const services = project.services.length > 0 ? project.services : [undefined];
            const isFinalProject = projectIndex === projects.length - 1;
            return (
              <Fragment key={project.id}>
                {services.map((service, serviceIndex) => (
                  <ServiceRow
                    isLast={isFinalProject && serviceIndex === services.length - 1}
                    isLastProject={isFinalProject}
                    key={service?.name ?? `${project.id}:empty`}
                    project={project}
                    rowSpan={serviceIndex === 0 ? services.length : undefined}
                    service={service}
                  />
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function ServiceRow({
  isLast,
  isLastProject,
  project,
  rowSpan,
  service,
}: {
  readonly isLast: boolean;
  readonly isLastProject: boolean;
  readonly project: Project;
  readonly rowSpan: number | undefined;
  readonly service: Service | undefined;
}) {
  return (
    <tr>
      {rowSpan ? (
        <td
          {...stylex.props(styles.cell, isLastProject && styles.lastCell, styles.projectName)}
          rowSpan={rowSpan}
        >
          <span {...stylex.props(styles.projectTitle)}>{project.name}</span>
          <span
            {...stylex.props(
              styles.projectState,
              project.state === "needs-attention" && styles.projectStateAttention,
            )}
          >
            {formatState(project.state)}
          </span>
          {project.restartRequired ? (
            <span {...stylex.props(styles.projectNote)}>Restart required</span>
          ) : null}
          {project.issue?.diagnostics[0] ? (
            <span {...stylex.props(styles.projectIssue)}>
              {project.issue.diagnostics[0].message}
            </span>
          ) : null}
        </td>
      ) : null}
      <td {...stylex.props(styles.cell, isLast && styles.lastCell, styles.serviceName)}>
        {service?.name ?? "No services"}
      </td>
      <td {...stylex.props(styles.cell, isLast && styles.lastCell)}>
        <span
          {...stylex.props(
            styles.state,
            (service?.state ?? project.state) === "running" && styles.stateRunning,
            ((service?.state ?? project.state) === "failed" ||
              (service?.state ?? project.state) === "needs-attention") &&
              styles.stateFailed,
          )}
        >
          {formatState(service?.state ?? project.state)}
        </span>
      </td>
      <td {...stylex.props(styles.cell, isLast && styles.lastCell)}>
        {service ? (
          <ServiceEndpoints service={service} />
        ) : (
          <span {...stylex.props(styles.muted)}>—</span>
        )}
      </td>
    </tr>
  );
}

function formatState(state: Project["state"] | Service["state"]): string {
  return state.replaceAll("-", " ");
}

function ServiceEndpoints({ service }: { readonly service: Service }) {
  if (service.endpoints.length === 0) {
    return <span {...stylex.props(styles.muted)}>None</span>;
  }

  return (
    <div {...stylex.props(styles.endpoints)}>
      {service.endpoints.map((endpoint) => (
        <a
          {...stylex.props(styles.endpointLink)}
          href={endpoint.url}
          key={endpoint.name}
          rel="noreferrer"
          target="_blank"
        >
          {endpoint.name}
          <span {...stylex.props(styles.endpointUrl)}>{endpoint.url}</span>
        </a>
      ))}
    </div>
  );
}

const styles = stylex.create({
  cell: {
    borderBottomColor: colors.rowBorder,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
    paddingBlock: spacing.medium,
    paddingInline: "20px",
    textAlign: "left",
    verticalAlign: "middle",
  },
  endpointLink: {
    alignItems: "baseline",
    color: {
      ":focus-visible": colors.interactiveTextHover,
      ":hover": colors.interactiveTextHover,
      default: colors.textLink,
    },
    display: "inline-flex",
    fontSize: 12,
    gap: spacing.small,
    textDecoration: {
      ":focus-visible": "underline",
      ":hover": "underline",
      default: "none",
    },
    textUnderlineOffset: "3px",
  },
  endpointUrl: {
    color: colors.textEndpoint,
    fontFamily: fonts.mono,
    fontSize: 11,
  },
  endpoints: {
    display: "flex",
    flexWrap: "wrap",
    gap: spacing.small,
  },
  headerCell: {
    color: colors.textSubtle,
    fontSize: 11,
    fontWeight: 650,
    letterSpacing: "0.07em",
    textTransform: "uppercase",
  },
  lastCell: {
    borderBottomStyle: "none",
  },
  muted: {
    color: colors.textDisabled,
  },
  panel: {
    backgroundColor: colors.surface,
    borderColor: colors.panelBorder,
    borderRadius: radii.panel,
    borderStyle: "solid",
    borderWidth: 1,
    overflowX: {
      "@media (max-width: 760px)": "auto",
      default: "hidden",
    },
    overflowY: "hidden",
  },
  projectName: {
    color: colors.textSecondary,
    verticalAlign: "top",
  },
  projectIssue: {
    color: colors.textMuted,
    display: "block",
    fontSize: 11,
    lineHeight: 1.4,
    marginTop: spacing.small,
    maxWidth: 260,
  },
  projectNote: {
    color: colors.textMuted,
    display: "block",
    fontSize: 11,
    marginTop: spacing.xSmall,
  },
  projectState: {
    color: colors.textMuted,
    display: "block",
    fontSize: 11,
    marginTop: spacing.xSmall,
    textTransform: "capitalize",
  },
  projectStateAttention: {
    color: colors.dangerText,
  },
  projectTitle: {
    color: colors.textSecondary,
  },
  serviceName: {
    color: colors.textStrong,
    fontWeight: 570,
  },
  state: {
    alignItems: "center",
    borderColor: colors.statusBorder,
    borderRadius: radii.pill,
    borderStyle: "solid",
    borderWidth: 1,
    color: colors.statusText,
    display: "inline-flex",
    fontSize: 12,
    lineHeight: 1,
    minWidth: 68,
    paddingBlock: spacing.xSmall,
    paddingInline: "9px",
    textTransform: "capitalize",
  },
  stateFailed: {
    backgroundColor: colors.dangerSurface,
    borderColor: colors.dangerBorder,
    color: colors.dangerText,
  },
  stateRunning: {
    backgroundColor: colors.successSurface,
    borderColor: colors.successBorder,
    color: colors.successText,
  },
  table: {
    borderCollapse: "collapse",
    minWidth: {
      "@media (max-width: 760px)": 680,
      default: "auto",
    },
    width: "100%",
  },
});
