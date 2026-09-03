import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";

import { colors, radii, spacing } from "../styling/theme.stylex.ts";
import { typography } from "../styling/typography.ts";

export interface BadgeProps {
  readonly children: ReactNode;
  readonly tone?: "danger" | "neutral" | "success";
}

export function Badge({ children, tone = "neutral" }: BadgeProps) {
  return (
    <span
      {...stylex.props(
        styles.badge,
        typography.badge,
        tone === "danger" && styles.danger,
        tone === "success" && styles.success,
      )}
    >
      {children}
    </span>
  );
}

const styles = stylex.create({
  badge: {
    alignItems: "center",
    borderColor: colors.statusBorder,
    borderRadius: radii.pill,
    borderStyle: "solid",
    borderWidth: 1,
    color: colors.statusText,
    display: "inline-flex",
    paddingBlock: spacing.xxSmall,
    paddingInline: spacing.small,
  },
  danger: {
    backgroundColor: colors.dangerSurface,
    borderColor: colors.dangerBorder,
    color: colors.dangerText,
  },
  success: {
    backgroundColor: colors.successSurface,
    borderColor: colors.successBorder,
    color: colors.successText,
  },
});
