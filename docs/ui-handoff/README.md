# hokago UI handoff — read me first

This folder is a spec package for rebuilding the finalized **hokago** front-end design
inside the real app (`github.com/rishabhroyy/hokago`). It was prepared from an approved
single-file HTML/CSS/JS prototype so you can recreate the look and feel **1:1** in the
production stack (React + Vite + Tailwind + shadcn/ui + Vidstack) without reverse-
engineering anything.

## The source of truth
`reference-prototype.html` is the finished, approved design. When any doc here is
ambiguous, **open the prototype and match it exactly** — pixel values, colors, timings,
and interactions in the prototype win over prose.

## Read in this order
1. **`HANDOFF.md`** — the implementation brief: goal, scope, plan, and a step-by-step
   build order with verification checkpoints.
2. **`design-system.md`** — every token (color, radius, spacing, type, shadow, easing)
   plus the exact "recipes" for the glossy / Wii-glow / plastic-sheen treatments.
3. **`components.md`** — how to decompose the single HTML file into React components,
   with prop shapes wired to the real data model.
4. **`interactions.md`** — the behavior layer (Wii sound blips, cursor tilt, selection
   glow, channel-zoom, staggered entrance, Konami code) and how to do each cleanly in
   React with proper cleanup.

## Paste-ready assets
- `tailwind.config.snippet.ts` — theme extension (colors, radii, shadows, keyframes, fonts).
- `globals.css.snippet.css` — CSS variables, base styles, and keyframes.
- `reference/useWiiSound.ts` — the Web-Audio hook, ready to adapt.
- `reference/Tile.tsx` — an exemplar poster tile (tilt + Wii-glow + gloss) to copy the pattern from.
- `reference/icons.tsx` — the full SVG icon set as a React sprite + `<Icon/>` helper.
- `logo.svg` — the 7-layer cat-ears mark (do not simplify; all 7 layers/fills matter).

## Non-negotiables (the design will feel wrong without these)
- The **pulsing blue Wii selection glow** on hover (`#4FB8E0`) — posters, chips, episode cards.
- The **glossy plastic sheen** on posters/buttons (crisp single highlight, never gradient soup).
- The **warm KyoAni palette** on a **cream dotted 2007-web background**.
- The **springy easing** `cubic-bezier(.4,1.4,.5,1)` on press/hover, not linear.
- The **soft Wii sound blips** on hover/select (they carry most of the "feel").
