module.exports = {
  darkMode: "media",
  content: ["./public/*.html", "./src/web/**/*.ts"],
  theme: {
    extend: {
      colors: {
        bg: "var(--sb-canvas)",
        surface: "var(--sb-surface)",
        "surface-raised": "var(--sb-surface-raised)",
        "surface-hover": "var(--sb-surface-hover)",
        "surface-highlight": "var(--sb-surface-highlight)",
        border: "var(--sb-border)",
        "line-subtle": "var(--sb-line-subtle)",
        muted: "var(--sb-muted)",
        ink: "var(--sb-ink)",
        "ink-strong": "var(--sb-ink-strong)",
        "ink-inverse": "var(--sb-ink-inverse)",
        icon: "var(--sb-icon-bg)",
        track: "var(--sb-track)",
        accent: "var(--sb-accent)",
        green: "var(--sb-green)",
        amber: "var(--sb-amber)",
        red: "var(--sb-red)",
      },
    },
  },
};
