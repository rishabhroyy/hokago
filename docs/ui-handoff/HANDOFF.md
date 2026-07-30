# HANDOFF — rebuild the hokago UI in the production app

## Goal
Recreate the approved prototype (`reference-prototype.html`) as real React components in
`github.com/rishabhroyy/hokago`, wired to the existing API/data model, matching the
prototype's look and feel 1:1. The prototype is warm-KyoAni + glossy-Wii/Frutiger-Aero,
on a cream dotted background.

## Stack (target)
React + Vite + TypeScript, Tailwind, shadcn/ui, Vidstack (player), TanStack Query for
data (or whatever the repo already uses — match existing conventions). The prototype is
framework-free; you are porting its CSS to Tailwind + a small amount of component CSS,
and its vanilla JS to hooks/handlers.

## Scope
Four views + persistent chrome, all present in the prototype:
- **Nav** (fixed top bar): brand→home, section links, live clock, expanding search, avatar, sound toggle.
- **Home**: featured **Hero**, then horizontally-scrolling **Rows** of poster **Tiles**.
- **Library**: filter **Chips** + responsive **Grid** of Tiles.
- **Detail**: banner + poster + actions (Play / +List / Download) + SUB/DUB toggle + episode grid.
- **Player**: Vidstack player with a skin matching the prototype's mock controls.

Out of scope (already removed from the design on purpose — do **not** add them back):
boot splash, animated landscape/sky background, cursor sparkle-trail, drifting petals/bubbles,
parallax hero scene, ambient background music. The background is the simple cream + dot texture.

## Guardrails (respect existing repo conventions)
- Work on a branch; **do not commit to `main`**. Small, reviewable commits.
- **No AI attribution** in commit messages or code comments.
- Match the repo's existing folder structure, lint/format config, and component patterns —
  read a few existing components first and mirror them before introducing new patterns.
- Keep it data-driven: the prototype hardcodes sample titles ("Windowseat", etc.); in the
  app these come from the API. Build components to take props (see `components.md`).
- Don't pull in heavy deps for things CSS/Tailwind already does. The only genuinely new
  runtime concern is the Web-Audio sound layer (tiny, no dep — see `interactions.md`).

## Recommended build order (each step independently verifiable)
1. **Design tokens** — paste `tailwind.config.snippet.ts` + `globals.css.snippet.css`,
   vendor the three fonts (Zen Maru Gothic, Plus Jakarta Sans, JetBrains Mono — all OFL/
   Apache; use `@fontsource/*` or self-host to match the repo's existing font strategy).
   ✔ Verify: a throwaway page using `bg-paper text-ink font-display` renders warm cream + rounded type.
2. **Icon sprite + logo** — drop in `reference/icons.tsx` and `logo.svg`.
   ✔ Verify: `<Icon name="play"/>` and the 7-layer logo both render.
3. **Tile** (the atom everything reuses) — port `reference/Tile.tsx`. Nail the gloss,
   the 2:3 art panel with per-title pastel pair, the hover **tilt**, and the **Wii-glow** pulse.
   ✔ Verify: hovering a tile lifts + tilts toward cursor + pulses a blue ring; pressing squashes.
4. **Nav** — brand (click→home, shimmer sweep), links w/ active state, live clock (setInterval,
   cleared on unmount), expanding search, avatar, sound toggle. ✔ Verify: clock ticks; search expands; logo routes home.
5. **Home** = Hero + Rows. Row = horizontal scroller with gutter arrow buttons (appear on
   hover, `scrollBy`). Hero = glossy coral panel, window art (bobbing), Resume (glossy) + Details.
   ✔ Verify: rows scroll via arrows and wheel/trackpad; hero buttons route to player/detail.
6. **Library** — chips (single-select) + auto-fill grid of Tiles. ✔ Verify: chips toggle; grid reflows.
7. **Detail** — banner/poster/actions/SUB-DUB/episode grid; episode cards reuse the Tile glow. ✔ Verify: SUB/DUB toggles; Play routes to player.
8. **Player** — Vidstack, skinned to match the prototype's control bar (coral scrub, pill controls,
   breadcrumb, watch-party chip). Nav hides while in the player. ✔ Verify: real playback with the custom skin.
9. **Interaction layer** — the `useWiiSound` hook + wire hover/select/back blips, the select
   star-ping, the channel-**zoom-open** on poster click, **staggered** entrance per view,
   and the **Konami** easter egg. ✔ Verify each against the prototype; all sound gated behind a toggle + first user gesture.

## Fidelity checklist (compare side-by-side with the prototype at the end)
- [ ] Warm cream bg with faint dot grid + soft top light.
- [ ] Poster tiles: 2:3, 16px radius, pastel gradient art, crisp top sheen, icon centered.
- [ ] Hover: lift + 3D tilt toward cursor + pulsing blue Wii ring (white inner + blue halo).
- [ ] Buttons: chunky pills, glossy top streak; Resume is white/glossy, primary actions coral.
- [ ] Section headers have the little coral rounded accent bar.
- [ ] Nav is glossy translucent with a bright top edge; clock is monospace and ticks.
- [ ] Springy easing on press; smooth easing on fades.
- [ ] Sound: soft hover tick, rising two-note select bloop, downward back boop; toggle in nav.
- [ ] Clicking a poster zooms it open to fill, then reveals Detail.
- [ ] Views stagger their tiles in; switching to Player hides the nav.
- [ ] Logo click returns home; logo has a periodic shimmer sweep.

When in doubt, open `reference-prototype.html` in a browser next to your build and diff by eye.
