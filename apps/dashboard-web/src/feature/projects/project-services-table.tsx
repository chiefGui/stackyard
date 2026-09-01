import * as stylex from "@stylexjs/stylex";

import type { Project, Service } from "@stackyard/protocol/projects";

import { colors, fonts, radii, spacing } from "../../styling/theme.stylex.ts";

export function ProjectServicesTable({ projects }: { readonly projects: readonly Project[] }) {
  const rows = projects.flatMap((project) =>
    project.services.map((service) => ({
      projectId: project.id,
      projectName: project.name,
      service,
    })),
  );

  return (
    <section {...stylex.props(styles.panel)} aria-label="Running services">
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
          {rows.map(({ projectId, projectName, service }, index) => (
            <ServiceRow
              isLast={index === rows.length - 1}
              key={`${projectId}:${service.name}`}
              projectName={projectName}
              service={service}
            />
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ServiceRow({
  isLast,
  projectName,
  service,
}: {
  readonly isLast: boolean;
  readonly projectName: string;
  readonly service: Service;
}) {
  return (
    <tr>
      <td {...stylex.props(styles.cell, isLast && styles.lastCell, styles.projectName)}>
        {projectName}
      </td>
      <td {...stylex.props(styles.cell, isLast && styles.lastCell, styles.serviceName)}>
        {service.name}
      </td>
      <td {...stylex.props(styles.cell, isLast && styles.lastCell)}>
        <span
          {...stylex.props(
            styles.state,
            service.state === "running" && styles.stateRunning,
            service.state === "failed" && styles.stateFailed,
          )}
        >
          {service.state}
        </span>
      </td>
      <td {...stylex.props(styles.cell, isLast && styles.lastCell)}>
        <ServiceEndpoints service={service} />
      </td>
    </tr>
  );
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
