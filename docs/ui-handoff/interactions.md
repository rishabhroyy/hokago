# Interaction layer

These are what make the UI *feel* like a Wii. Port each faithfully; all are cheap and
dependency-free. Everything audible is gated behind (a) a sound toggle and (b) a first
user gesture (browsers block audio before one).

## 1. Wii sound blips (Web Audio, no files)
Synthesized on the fly. See `reference/useWiiSound.ts` for the ready hook. Behaviors:
- **hover** → soft high tick: sine, 880Hz, ~55ms, vol .045. Fire on `pointerenter` of
  tiles/links/buttons/chips/arrows/icon-buttons/episodes.
- **select** → rising two-note bloop: triangle 523.25Hz then 783.99Hz (~55ms apart). Fire on any navigating click.
- **back** → downward boop: sine 520→300Hz glide, ~120ms. Fire on back/close.
- **row page** → soft whoosh: sine, up (360→680) for right, down (660→340) for left.
- **first-interaction jingle** → ascending C-E-G-C (triangle) once, on first gesture (unlocks the AudioContext).
Provide the hook via context so the `<SoundToggle>` can mute globally. Create/resume the
`AudioContext` lazily inside the play functions and on first `pointerdown`.

## 2. Cursor tilt on tiles
On `pointermove` within a tile, tilt the **inner art panel** toward the cursor:
```ts
const r = tileEl.getBoundingClientRect();
const rx = ((e.clientY - r.top) / r.height - 0.5) * -8;   // ±8deg
const ry = ((e.clientX - r.left) / r.width  - 0.5) *  8;
artEl.style.transform = `rotateX(${rx}deg) rotateY(${ry}deg)`;
// on pointerleave: artEl.style.transform = "";
```
Requires `.tile{ perspective:640px }` and a short transform transition on `.art`.
The hover **lift** stays in CSS (`translateY(-6px)` on `.tile:hover`) so it composes with the tilt on the child.

## 3. Wii selection glow
CSS-only (see `design-system.md` §2). Just add/keep the `wiipulse` animation on `.tile:hover .art`,
the chip/episode variants, and make sure the art has `overflow:hidden` (the sheen is clipped, the glow is a box-shadow so it shows outside).

## 4. Springy select-pop + Lucky-Star ✨ ping
On a navigating click that is **not** a poster-zoom:
- add a `pop` class to the target for 340ms → `@keyframes popsel { 0%{scale(1)} 42%{scale(1.1)} 100%{scale(1)} }` with `--e-snap`.
- spawn a small gold star at the pointer that floats up and fades (~600ms), then remove it.

## 5. Channel-zoom open (poster → detail)
The signature Wii "channel opens" move. On clicking a poster tile that navigates to Detail:
1. read the art element's rect + computed `background-image`/`background-color`,
2. create a fixed overlay div at that rect with the same fill + a white ring + blue glow,
3. next frame, transition it to fullscreen (`inset:0`, `border-radius:0`) over ~.42s,
4. it covers the (instant) route change; then fade the overlay out (~.3s) and remove it.
Wrap in try/catch and fall back to a normal navigate. See the prototype's `zoomOpen()`.
In React, do this in the click handler before/に navigation; keep the overlay outside the
routed tree (portal to `body`) so the route change underneath doesn't unmount it.

## 6. Staggered entrance
When a view becomes active, animate its tiles/episode cards in:
`riseIn .5s var(--e) <i*0.035s capped at .5s> both`, then clear the inline animation on
`animationend` so hover transforms work afterward. In React, trigger on the view's mount/
route-enter (e.g. an effect keyed on the active route) over the rendered tile refs, or use
a CSS approach with incremental `animation-delay`. Keyframe:
`@keyframes riseIn { from{opacity:0; translateY(18px)} to{opacity:1; translateY(0)} }`.

## 7. Live clock
`setInterval(tick, 10000)` formatting `h:mm AM/PM`; **clear on unmount**. Monospace, muted ink-3.

## 8. Expanding search
Icon button toggles an `open` class on the wrapper; the input animates `width 0→220px` +
opacity with `--e-snap`. Close on outside click; focus the input on open.

## 9. Konami code easter egg
Keydown sequence `↑↑↓↓←→←→ B A` → play the jingle + a shower of ~22 star pings at random
positions. Keep the tiny state machine; reset on wrong key.

## 10. Logo shimmer + home
The brand is a button: click → route home; a `::before`/child element sweeps a light streak
across it every 5s (`shine` keyframe). Springy press.

## React cleanup checklist
- Every `setInterval`/`setTimeout`/`requestAnimationFrame` and every global
  (`pointermove`, `keydown`, outside-click) listener is removed on unmount.
- The AudioContext is created once (memoized/singleton) and resumed on gesture, not per play.
- Portaled overlays (zoom, star pings) are always removed after their animation.
- Respect `prefers-reduced-motion`: gate the tilt, pulses, stagger, and pings behind it
  (fall back to instant states) — good practice the prototype didn't bother with.
