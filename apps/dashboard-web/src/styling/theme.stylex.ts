import * as stylex from "@stylexjs/stylex";

export const colors = stylex.defineVars({
  canvas: "#080a0c",
  dangerBorder: "#563337",
  dangerIndicator: "#d67177",
  dangerSurface: "#211416",
  dangerText: "#dc898e",
  interactiveTextHover: "#aae8c7",
  panelBorder: "#22282d",
  rowBorder: "#1d2327",
  statusBorder: "#30373d",
  statusText: "#8c959c",
  successBorder: "#28553d",
  successIndicator: "#65c98d",
  successSurface: "#0d1d15",
  successText: "#72d39a",
  surface: "#0e1114",
  surfaceMuted: "#0b0e10",
  text: "#cbd1d5",
  textDisabled: "#535b61",
  textEndpoint: "#6f787f",
  textHeading: "#e6eaec",
  textLink: "#8bceb0",
  textMuted: "#737c82",
  textSecondary: "#959da3",
  textStatus: "#858f95",
  textStrong: "#dce1e4",
  textSubtle: "#687279",
});

export const fonts = stylex.defineVars({
  body: "'Inter Variable', Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  mono: "'SFMono-Regular', Consolas, 'Liberation Mono', monospace",
});

export const radii = stylex.defineVars({
  control: "6px",
  panel: "12px",
  pill: "999px",
});

export const spacing = stylex.defineVars({
  large: "16px",
  medium: "12px",
  small: "8px",
  xLarge: "24px",
  xxLarge: "32px",
  xxSmall: "2px",
  xxxLarge: "48px",
  xSmall: "4px",
});
