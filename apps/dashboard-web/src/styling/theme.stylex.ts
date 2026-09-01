import * as stylex from "@stylexjs/stylex";

export const colors = stylex.defineVars({
  canvas: "#0c0e12",
  dangerBorder: "#543030",
  dangerIndicator: "#d47575",
  dangerSurface: "#251516",
  dangerText: "#d28c8c",
  interactiveTextHover: "#ffffff",
  panelBorder: "#242830",
  rowBorder: "#22262e",
  statusBorder: "#303640",
  statusText: "#a8afb9",
  successBorder: "#285440",
  successIndicator: "#57b987",
  successSurface: "#11251c",
  successText: "#79c99f",
  surface: "#11141a",
  text: "#e8ebef",
  textDisabled: "#676e78",
  textEndpoint: "#737b87",
  textHeading: "#dce0e5",
  textLink: "#cbd1da",
  textMuted: "#858b95",
  textSecondary: "#969da8",
  textStatus: "#9ca3ad",
  textStrong: "#f2f4f7",
  textSubtle: "#7e8590",
});

export const fonts = stylex.defineVars({
  body: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  mono: "'SFMono-Regular', Consolas, 'Liberation Mono', monospace",
});

export const radii = stylex.defineVars({
  panel: "12px",
  pill: "999px",
});

export const spacing = stylex.defineVars({
  large: "32px",
  medium: "16px",
  small: "8px",
  xLarge: "48px",
  xSmall: "4px",
});
