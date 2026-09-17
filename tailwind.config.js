const tokenColor = (name) => `rgb(var(${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        primary: { DEFAULT: tokenColor("--color-primary"), container: tokenColor("--color-primary-container") },
        "on-primary": { DEFAULT: tokenColor("--color-on-primary"), container: tokenColor("--color-on-primary-container") },
        surface: {
          canvas: tokenColor("--color-surface-canvas"),
          base: tokenColor("--color-surface-base"),
          raised: tokenColor("--color-surface-raised"),
          inset: tokenColor("--color-surface-inset"),
          soft: tokenColor("--color-surface-soft")
        },
        boundary: {
          DEFAULT: tokenColor("--color-boundary-default"),
          strong: tokenColor("--color-boundary-strong")
        },
        content: {
          primary: tokenColor("--color-content-primary"),
          secondary: tokenColor("--color-content-secondary"),
          muted: tokenColor("--color-content-muted"),
          subtle: tokenColor("--color-content-subtle")
        },
        feedback: {
          running: tokenColor("--color-feedback-running"),
          success: tokenColor("--color-feedback-success"),
          warning: tokenColor("--color-feedback-warning"),
          danger: tokenColor("--color-feedback-danger")
        },
        /* Existing semantic aliases remain theme-aware; new UI uses surface/boundary/feedback. */
        panel: {
          base: tokenColor("--color-surface-base"),
          raised: tokenColor("--color-surface-raised"),
          line: tokenColor("--color-boundary-default"),
          soft: tokenColor("--color-surface-soft")
        },
        accent: {
          cyan: tokenColor("--color-feedback-running"),
          green: tokenColor("--color-feedback-success"),
          yellow: tokenColor("--color-feedback-warning"),
          red: tokenColor("--color-feedback-danger")
        }
      },
      spacing: {
        "ui-1": "0.25rem",
        "ui-2": "0.5rem",
        "ui-3": "0.75rem",
        "ui-4": "1rem",
        "ui-5": "1.25rem",
        "workspace-gutter": "var(--workspace-gutter)"
      },
      fontSize: {
        "ui-caption": ["0.75rem", { lineHeight: "1.125rem" }],
        "ui-helper": ["0.75rem", { lineHeight: "1rem" }],
        "ui-body": ["0.875rem", { lineHeight: "1.375rem" }],
        "ui-section": ["0.875rem", { lineHeight: "1.25rem" }],
        "ui-title": ["1.5rem", { lineHeight: "2rem" }]
      },
      height: {
        "control-sm": "2rem",
        control: "2rem",
        "control-lg": "2.5rem"
      },
      width: {
        control: "2rem"
      },
      minHeight: {
        "control-sm": "2rem",
        control: "2rem",
        "control-lg": "2.5rem"
      },
      borderRadius: {
        control: "999px",
        panel: "0.875rem",
        dialog: "1.25rem"
      },
      boxShadow: {
        "focus-ring": "0 0 0 2px rgb(var(--color-focus-ring) / 0.9)",
        workspace: "0 12px 40px rgb(var(--color-surface-canvas) / 0.18)",
        "active-step": "inset 0 -2px 0 rgb(var(--color-feedback-running) / 0.75)",
        "selection-guide": "0 0 0 1px rgb(var(--color-timeline-clip-text) / 0.8)"
      },
      fontFamily: {
        ui: [
          "Inter",
          "Segoe UI",
          "Microsoft YaHei UI",
          "Microsoft YaHei",
          "sans-serif"
        ]
      }
    }
  },
  plugins: []
};
