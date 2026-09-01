import * as stylex from "@stylexjs/stylex";
import { createRootRoute, Link, Outlet, type ErrorComponentProps } from "@tanstack/react-router";

import { colors, fonts } from "../styling/theme.stylex.ts";

export const Route = createRootRoute({
  component: AppRoot,
  errorComponent: AppError,
  notFoundComponent: NotFound,
});

function AppRoot() {
  return (
    <div {...stylex.props(styles.root)}>
      <Outlet />
    </div>
  );
}

function AppError({ error, reset }: ErrorComponentProps) {
  return (
    <main {...stylex.props(styles.message)}>
      <h1 {...stylex.props(styles.heading)}>Dashboard unavailable</h1>
      <p {...stylex.props(styles.copy)}>{error.message}</p>
      <button {...stylex.props(styles.action)} onClick={reset} type="button">
        Retry
      </button>
    </main>
  );
}

function NotFound() {
  return (
    <main {...stylex.props(styles.message)}>
      <h1 {...stylex.props(styles.heading)}>Page not found</h1>
      <p {...stylex.props(styles.copy)}>Return to the dashboard and try again.</p>
      <Link {...stylex.props(styles.action)} to="/">
        Dashboard
      </Link>
    </main>
  );
}

const styles = stylex.create({
  action: {
    backgroundColor: "transparent",
    borderColor: colors.statusBorder,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    color: {
      ":focus-visible": colors.interactiveTextHover,
      ":hover": colors.interactiveTextHover,
      default: colors.textLink,
    },
    display: "inline-flex",
    fontFamily: fonts.body,
    fontSize: 13,
    marginTop: 16,
    paddingBlock: 7,
    paddingInline: 12,
    textDecoration: "none",
  },
  copy: {
    color: colors.textMuted,
    fontSize: 13,
  },
  heading: {
    color: colors.textHeading,
    fontSize: 18,
    fontWeight: 570,
    marginBottom: 7,
  },
  message: {
    marginInline: "auto",
    maxWidth: 480,
    paddingBlock: 80,
    paddingInline: 24,
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
