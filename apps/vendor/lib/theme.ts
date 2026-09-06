/**
 * Built for a phone held at arm's length, outdoors, in Kolkata sun, by someone
 * wearing gloves. Large type, high contrast, and touch targets no smaller than
 * 48pt — the usual mobile design instincts are wrong here.
 */
export const theme = {
  colour: {
    bg: "#0B1220",
    surface: "#141C2B",
    surfaceAlt: "#1D2739",
    border: "#2A3548",
    text: "#F5F7FA",
    textMuted: "#94A3B8",
    primary: "#2563EB",
    /** The peak bar on the Today chart, and nothing else. */
    primaryBright: "#60A5FA",
    primaryText: "#FFFFFF",
    success: "#16A34A",
    warning: "#D97706",
    danger: "#DC2626",
  },
  space: (n: number) => n * 8,
  radius: { sm: 8, md: 12, lg: 16, pill: 999 },
  text: {
    /** Plate numbers and fares — readable without bringing the phone closer. */
    display: { fontSize: 34, fontWeight: "700" as const, letterSpacing: 0.5 },
    title: { fontSize: 22, fontWeight: "700" as const },
    body: { fontSize: 17, fontWeight: "500" as const },
    label: { fontSize: 13, fontWeight: "600" as const, letterSpacing: 0.6 },
    small: { fontSize: 13, fontWeight: "500" as const },
  },
  /** Nothing tappable is smaller than this. Gloves, movement, bad light. */
  minTouch: 48,
};
