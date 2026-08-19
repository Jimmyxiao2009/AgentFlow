export const agentFlowTokens = {
  colors: {
    window: "#0D0F12",
    sidebar: "#111419",
    conversation: "#13171C",
    inspector: "#101318",
    elevated: "#181D24",
    hover: "#1D232C",
    selected: "#202936",
    textPrimary: "#E7EAF0",
    textSecondary: "#A7AFBC",
    textMuted: "#727B89",
    borderSubtle: "#252C36",
    borderStrong: "#343D49",
    accent: "#5DA9FF",
    success: "#4CC38A",
    warning: "#E5B454",
    danger: "#EF6B73",
  },
  radius: { none: 0, xs: 4, sm: 6, md: 8, lg: 10, xl: 12, overlay: 14 },
  spacing: [4, 8, 12, 16, 20, 24, 32],
  motion: { fast: 100, normal: 160, slow: 220 },
} as const;

export const agentFlowAccentColors = {
  Blue: "#5DA9FF",
  Cyan: "#5DD8E5",
  Purple: "#B48BFF",
  Green: "#4CC38A",
  Orange: "#E5A354",
  System: "#A7AFBC",
} as const;

export function tokenCss(theme: "dark" | "light" = "dark"): string {
  const colors =
    theme === "dark"
      ? agentFlowTokens.colors
      : {
          ...agentFlowTokens.colors,
          window: "#F5F7FA",
          sidebar: "#EDF1F5",
          conversation: "#FFFFFF",
          inspector: "#F7F9FB",
          elevated: "#FFFFFF",
          hover: "#E8EEF5",
          selected: "#DDEBFA",
          textPrimary: "#18212B",
          textSecondary: "#4D5B6A",
          textMuted: "#718091",
          borderSubtle: "#D6DEE8",
          borderStrong: "#AEBACA",
        };
  return Object.entries(colors)
    .map(
      ([key, value]) =>
        `--af-${key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)}:${value}`,
    )
    .join(";");
}
