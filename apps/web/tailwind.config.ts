import type { Config } from "tailwindcss";

// hokago design tokens — verbatim from docs/ui-handoff/design-system.md,
// the approved prototype (reference-prototype.html) is the source of truth.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        paper: "#F6F0E6",
        "paper-2": "#EFE7D8",
        card: "#FFFFFF",
        ink: "#35302B",
        "ink-2": "#72695F",
        "ink-3": "#8B8177",
        line: "#E6DDCE",
        "line-2": "#D8CEBC",
        accent: "#E8664F",
        "accent-2": "#F0836F",
        gold: "#E3A34C",
        wii: "#4FB8E0",
        "wii-2": "#8FE0F5",
        "wii-deep": "#2E9BC4",
        "wii-ink": "#177A9E",
        // per-title poster pastels (deterministic pair per title, e.g. id % 6)
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
      transitionTimingFunction: {
        snap: "cubic-bezier(.4,1.4,.5,1)", // press / hover / pop
        smooth: "cubic-bezier(.4,0,.2,1)", // fades / view transitions
      },
      boxShadow: {
        // the glossy plastic art panel
        plastic:
          "inset 0 1.5px 0 rgba(255,255,255,0.6), inset 0 0 0 1px rgba(255,255,255,0.14), 0 3px 10px -4px rgba(120,80,60,0.28)",
        // resting Wii glow (compose the pulse via the keyframes below)
        "wii-ring":
          "0 0 0 3px #fff, 0 0 0 5px #4FB8E0, 0 0 15px 1px rgba(79,184,224,0.55), 0 14px 26px -8px rgba(120,80,60,0.4)",
        // floating white panel — nav, cards, login
        panel:
          "inset 0 1.5px 0 rgba(255,255,255,0.9), 0 2px 6px -2px rgba(120,80,60,0.14), 0 18px 44px -18px rgba(120,80,60,0.35)",
        // glossy blue primary action
        "btn-blue":
          "inset 0 1.5px 0 rgba(255,255,255,0.45), 0 6px 18px -6px rgba(46,155,196,0.65)",
        "btn-blue-hover":
          "inset 0 1.5px 0 rgba(255,255,255,0.45), 0 4px 24px -2px rgba(79,184,224,0.8), 0 0 0 3px rgba(255,255,255,0.9), 0 0 0 5px rgba(79,184,224,0.5)",
      },
      keyframes: {
        wiipulse: {
          "0%,100%": { boxShadow: "0 0 0 3px #fff, 0 0 0 5px #4FB8E0, 0 0 15px 1px rgba(79,184,224,.55), 0 14px 26px -8px rgba(120,80,60,.4)" },
          "50%": { boxShadow: "0 0 0 3px #fff, 0 0 0 6px #4FB8E0, 0 0 26px 4px rgba(79,184,224,.55), 0 14px 26px -8px rgba(120,80,60,.4)" },
        },
        popsel: { "0%,100%": { transform: "scale(1)" }, "42%": { transform: "scale(1.1)" } },
        riseIn: { from: { opacity: "0", transform: "translateY(18px)" }, to: { opacity: "1", transform: "translateY(0)" } },
        zoomin: { from: { opacity: "0", transform: "scale(.94)" }, to: { opacity: "1", transform: "scale(1)" } },
        bob: { "0%,100%": { transform: "translateY(-50%)" }, "50%": { transform: "translateY(-58%)" } },
        shine: { "0%,72%": { transform: "translateX(-130%)" }, "86%,100%": { transform: "translateX(130%)" } },
      },
      animation: {
        wiipulse: "wiipulse 1.3s ease-in-out infinite",
        popsel: "popsel .34s cubic-bezier(.4,1.4,.5,1)",
        riseIn: "riseIn .5s cubic-bezier(.4,0,.2,1) both",
        zoomin: "zoomin .42s cubic-bezier(.4,0,.2,1)",
        bob: "bob 4.5s ease-in-out infinite",
        shine: "shine 5s ease-in-out infinite",
      },
    },
  },
} satisfies Config;
