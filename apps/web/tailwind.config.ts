import type { Config } from "tailwindcss";

// hokago design tokens — the warm KyoAni / glossy Wii world, single hardcoded design.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Semantic tokens are CSS variables redefined in app.css's `.dark`
        // scope, so one theme swap re-themes every utility that uses them.
        paper: "var(--paper)",
        "paper-2": "var(--paper-2)",
        card: "var(--card)",
        ink: "var(--ink)",
        "ink-2": "var(--ink-2)",
        "ink-3": "var(--ink-3)",
        line: "var(--line)",
        "line-2": "var(--line-2)",
        accent: "var(--accent)",
        "accent-2": "var(--accent-2)",
        gold: "var(--gold)",
        wii: "var(--wii)",
        "wii-2": "var(--wii-2)",
        "wii-deep": "var(--wii-deep)",
        "wii-ink": "var(--wii-ink)",
        // per-title poster pastels (deterministic pair per title, e.g. id % 6)
        // — channel art, identical in both themes, so kept as literal hex
        p1a: "#F4A98C", p1b: "#EE8E6C",
        p2a: "#ED9DAE", p2b: "#E2879A",
        p3a: "#EFCB79", p3b: "#E4B457",
        p4a: "#A9CDA0", p4b: "#89B683",
        p5a: "#9BCBE0", p5b: "#78B3D0",
        p6a: "#F09E86", p6b: "#E27862",
      },
      borderRadius: {
        tile: "16px",
        panel: "22px",
        hero: "28px",
      },
      fontFamily: {
        display: ['"Zen Maru Gothic"', "sans-serif"],
        sans: ['"Plus Jakarta Sans"', "sans-serif"],
        mono: ['"JetBrains Mono"', "monospace"],
      },
      fontSize: {
        // Purpose-named role scale. Display tier is Zen Maru (rounded, warm);
        // body/UI tier is Plus Jakarta; kicker is the uppercase mono label.
        display: ["48px", { lineHeight: "1.04", letterSpacing: "-0.015em" }], // home hero
        "title-xl": ["40px", { lineHeight: "1.04", letterSpacing: "-0.01em" }], // detail hero
        title: ["28px", { lineHeight: "1.15", letterSpacing: "-0.01em" }], // page titles
        section: ["21px", { lineHeight: "1.2" }], // row / section heads
        "card-head": ["16px", { lineHeight: "1.35" }], // card heads in the admin console
        "card-title": ["13.5px", { lineHeight: "1.3" }], // tile names
        body: ["14.5px", { lineHeight: "1.75" }], // prose
        meta: ["13px", { lineHeight: "1.5" }], // chips, table cells, lists
        small: ["12px", { lineHeight: "1.4" }], // dense UI, table jazz, badges
        kicker: ["10.5px", { lineHeight: "1.4" }], // uppercase mono labels
      },
      transitionTimingFunction: {
        // restrained press / hover — smooth-out, no overshoot bounce
        snap: "cubic-bezier(.25,.5,.3,1)",
        smooth: "cubic-bezier(.4,0,.2,1)", // fades / view transitions
      },
      boxShadow: {
        // quiet hover lift for tiles / cards — a soft drop, no halo
        cardLift: "0 14px 30px -16px rgba(80,50,30,0.4)",
        // the glossy plastic art panel
        plastic:
          "inset 0 1.5px 0 rgba(255,255,255,0.6), inset 0 0 0 1px rgba(255,255,255,0.14), 0 3px 10px -4px rgba(120,80,60,0.28)",
        // floating white panel — nav, cards, login (variable so .dark can
        // soften the white sheen and deepen the drop shadow on dark surfaces)
        panel: "var(--shadow-panel)",
        // glossy blue primary action
        "btn-blue":
          "inset 0 1.5px 0 rgba(255,255,255,0.45), 0 6px 18px -8px rgba(46,155,196,0.5)",
        "btn-blue-hover":
          "inset 0 1.5px 0 rgba(255,255,255,0.45), 0 8px 22px -10px rgba(79,184,224,0.5)",
      },
      keyframes: {
        riseIn: { from: { opacity: "0", transform: "translateY(12px)" }, to: { opacity: "1", transform: "translateY(0)" } },
      },
      animation: {
        riseIn: "riseIn .5s cubic-bezier(.4,0,.2,1) both",
      },
    },
  },
} satisfies Config;
