import * as stylex from "@stylexjs/stylex";

export const typography = stylex.create({
  badge: {
    fontSize: "0.6875rem",
    fontWeight: 500,
    lineHeight: 1.45,
  },
  body: {
    fontSize: "0.8125rem",
    fontWeight: 400,
    lineHeight: 1.5,
  },
  bodyStrong: {
    fontSize: "0.8125rem",
    fontWeight: 500,
    lineHeight: 1.5,
  },
  detail: {
    fontSize: "0.6875rem",
    fontWeight: 400,
    lineHeight: 1.45,
  },
  label: {
    fontSize: "0.75rem",
    fontWeight: 500,
    lineHeight: 1.333,
  },
  overline: {
    fontSize: "0.625rem",
    fontWeight: 600,
    letterSpacing: "0.08em",
    lineHeight: 1.6,
    textTransform: "uppercase",
  },
  subtitle: {
    fontSize: "0.875rem",
    fontWeight: 600,
    letterSpacing: "-0.01em",
    lineHeight: 1.429,
  },
  title: {
    fontSize: "1.125rem",
    fontWeight: 600,
    letterSpacing: "-0.015em",
    lineHeight: 1.333,
  },
});
