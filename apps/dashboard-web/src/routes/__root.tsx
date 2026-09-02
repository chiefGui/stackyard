import * as stylex from "@stylexjs/stylex";
import { Button } from "@ariakit/react";
import { createRootRoute, Link, Outlet, type ErrorComponentProps } from "@tanstack/react-router";

import { colors, fonts, radii, spacing } from "../styling/theme.stylex.ts";
import { typography } from "../styling/typography.ts";

export const Route = createRootRoute({
  component: AppRoot,
  errorComponent: AppError,
  notFoundComponent: NotFound,
});

function AppRoot() {
  return (
    <div {...stylex.props(styles.root, typography.body)}>
      <Outlet />
    </div>
  );
}

function AppError({ error, reset }: ErrorComponentProps) {
  return (
    <main {...stylex.props(styles.message)}>
      <h1 {...stylex.props(styles.heading, typography.title)}>Dashboard unavailable</h1>
      <p {...stylex.props(styles.copy, typography.body)}>{error.message}</p>
      <Button {...stylex.props(styles.action, typography.bodyStrong)} onClick={reset} type="button">
        Retry
      </Button>
    </main>
  );
}

function NotFound() {
  return (
    <main {...stylex.props(styles.message)}>
      <h1 {...stylex.props(styles.heading, typography.title)}>Page not found</h1>
      <p {...stylex.props(styles.copy, typography.body)}>Return to the dashboard and try again.</p>
      <Link {...stylex.props(styles.action, typography.bodyStrong)} to="/">
        Dashboard
      </Link>
    </main>
  );
}

const styles = stylex.create({
  action: {
    backgroundColor: "transparent",
    borderColor: colors.statusBorder,
    borderRadius: radii.control,
    borderStyle: "solid",
    borderWidth: 1,
    color: {
      ":focus-visible": colors.interactiveTextHover,
      ":hover": colors.interactiveTextHover,
      default: colors.textLink,
    },
    display: "inline-flex",
    fontFamily: fonts.body,
    marginTop: spacing.large,
    paddingBlock: spacing.small,
    paddingInline: spacing.medium,
    textDecoration: "none",
  },
  copy: {
    color: colors.textMuted,
  },
  heading: {
    color: colors.textHeading,
    marginBottom: spacing.small,
  },
  message: {
    marginInline: "auto",
    maxWidth: 480,
    paddingBlock: spacing.xxxLarge,
    paddingInline: spacing.xLarge,
    textAlign: "center",
  },
  root: {
    backgroundColor: colors.canvas,
    color: colors.text,
    colorScheme: "dark",
    fontFamily: fonts.body,
    minHeight: "100vh",
  },
});
