import * as stylex from "@stylexjs/stylex";

import type { Project, Service } from "@stackyard/protocol/projects";

import { Badge, type BadgeProps } from "../../primitive/badge.tsx";
import { colors, fonts, radii, spacing } from "../../styling/theme.stylex.ts";
import { typography } from "../../styling/typography.ts";

export function ProjectCards({ projects }: { readonly projects: readonly Project[] }) {
  return (
    <section {...stylex.props(styles.cards)} aria-label="Projects">
      {projects.map((project) => (
        <ProjectCard key={project.id} project={project} />
      ))}
    </section>
  );
}

function ProjectCard({ project }: { readonly project: Project }) {
  return (
    <article {...stylex.props(styles.card)}>
      <header {...stylex.props(styles.cardHeader)}>
        <div {...stylex.props(styles.projectHeading)}>
          <h2 {...stylex.props(styles.projectTitle, typography.subtitle)}>{project.name}</h2>
          <State state={project.state} />
        </div>
        {project.restartRequired ? (
          <p {...stylex.props(styles.projectNote, typography.label)}>Restart required</p>
        ) : null}
        {project.issue?.diagnostics[0] ? (
          <p {...stylex.props(styles.projectIssue, typography.label)}>
            {project.issue.diagnostics[0].message}
          </p>
        ) : null}
      </header>
      <div {...stylex.props(styles.tableViewport)}>
        <table {...stylex.props(styles.table)}>
          <thead>
            <tr>
              <th
                {...stylex.props(
                  styles.cell,
                  styles.headerCell,
                  styles.serviceColumn,
                  typography.overline,
                )}
              >
                Service
              </th>
              <th
                {...stylex.props(
                  styles.cell,
                  styles.headerCell,
                  styles.statusColumn,
                  typography.overline,
                )}
              >
                Status
              </th>
              <th
                {...stylex.props(
                  styles.cell,
                  styles.headerCell,
                  styles.endpointColumn,
                  typography.overline,
                )}
              >
                Endpoint
              </th>
            </tr>
          </thead>
          <tbody>
            {project.services.length > 0 ? (
              project.services.map((service, index) => (
                <ServiceRow
                  isLast={index === project.services.length - 1}
                  key={service.name}
                  service={service}
                />
              ))
            ) : (
              <tr>
                <td
                  {...stylex.props(
                    styles.cell,
                    styles.lastCell,
                    styles.serviceName,
                    typography.bodyStrong,
                  )}
                >
                  No services
                </td>
                <td {...stylex.props(styles.cell, styles.lastCell)}>
                  <State state={project.state} />
                </td>
                <td {...stylex.props(styles.cell, styles.lastCell)}>
                  <span {...stylex.props(styles.muted)}>None</span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </article>
  );
}

function ServiceRow({ isLast, service }: { readonly isLast: boolean; readonly service: Service }) {
  return (
    <tr>
      <td
        {...stylex.props(
          styles.cell,
          isLast && styles.lastCell,
          styles.serviceName,
          typography.bodyStrong,
        )}
      >
        {service.name}
      </td>
      <td {...stylex.props(styles.cell, isLast && styles.lastCell)}>
        <State state={service.state} />
      </td>
      <td {...stylex.props(styles.cell, isLast && styles.lastCell)}>
        <ServiceEndpoints service={service} />
      </td>
    </tr>
  );
}

function State({ state }: { readonly state: Project["state"] | Service["state"] }) {
  let tone: BadgeProps["tone"] = "neutral";
  if (state === "running") {
    tone = "success";
  } else if (state === "failed" || state === "needs-attention") {
    tone = "danger";
  }
  const label = state.replaceAll("-", " ");
  return <Badge tone={tone}>{`${label.charAt(0).toUpperCase()}${label.slice(1)}`}</Badge>;
}

function ServiceEndpoints({ service }: { readonly service: Service }) {
  if (service.endpoints.length === 0) {
    return <span {...stylex.props(styles.muted)}>None</span>;
  }

  return (
    <div {...stylex.props(styles.endpoints)}>
      {service.endpoints.map((endpoint) => (
        <a
          {...stylex.props(styles.endpointLink, typography.label)}
          href={endpoint.url}
          key={endpoint.name}
          rel="noreferrer"
          target="_blank"
        >
          {endpoint.name}
          <span {...stylex.props(styles.endpointUrl, typography.detail)}>{endpoint.url}</span>
        </a>
      ))}
    </div>
  );
}

const styles = stylex.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.panelBorder,
    borderRadius: radii.panel,
    borderStyle: "solid",
    borderWidth: 1,
    overflow: "hidden",
  },
  cardHeader: {
    paddingBlock: spacing.large,
    paddingInline: {
      "@media (max-width: 760px)": spacing.large,
      default: spacing.large,
    },
  },
  cards: {
    display: "grid",
    gap: spacing.large,
  },
  cell: {
    borderBottomColor: colors.rowBorder,
    borderBottomStyle: "solid",
    borderBottomWidth: 1,
    paddingBlock: spacing.medium,
    paddingInline: spacing.large,
    textAlign: "left",
    verticalAlign: "middle",
  },
  endpointColumn: {
    width: "46%",
  },
  endpointLink: {
    alignItems: "baseline",
    color: {
      ":focus-visible": colors.interactiveTextHover,
      ":hover": colors.interactiveTextHover,
      default: colors.textLink,
    },
    display: "inline-flex",
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
  },
  endpoints: {
    display: "flex",
    flexWrap: "wrap",
    gap: spacing.small,
  },
  headerCell: {
    backgroundColor: colors.surfaceMuted,
    color: colors.textSubtle,
    paddingBlock: spacing.small,
  },
  lastCell: {
    borderBottomStyle: "none",
  },
  muted: {
    color: colors.textDisabled,
  },
  projectHeading: {
    alignItems: "center",
    display: "flex",
    flexWrap: "wrap",
    gap: spacing.small,
  },
  projectIssue: {
    color: colors.dangerText,
    marginTop: spacing.small,
  },
  projectNote: {
    color: colors.textMuted,
    marginTop: spacing.small,
  },
  projectTitle: {
    color: colors.textHeading,
  },
  serviceColumn: {
    width: "34%",
  },
  serviceName: {
    color: colors.textStrong,
  },
  statusColumn: {
    width: "20%",
  },
  table: {
    borderCollapse: "collapse",
    minWidth: 620,
    width: "100%",
  },
  tableViewport: {
    borderTopColor: colors.rowBorder,
    borderTopStyle: "solid",
    borderTopWidth: 1,
    overflowX: "auto",
  },
});
