# hokago design system

All values are taken verbatim from `reference-prototype.html`. When adapting to Tailwind,
keep the names below so the docs and code line up.

## Color tokens
| token | value | role |
|---|---|---|
| `paper` | `#F6F0E6` | app background (warm cream) |
| `paper-2` | `#EFE7D8` | slightly deeper cream |
| `card` | `#FFFFFF` | surfaces |
| `ink` | `#35302B` | primary text (warm near-black) |
| `ink-2` | `#8B8177` | secondary text |
| `ink-3` | `#B4ABA0` | tertiary / muted |
| `line` | `#E6DDCE` | hairline borders |
| `line-2` | `#D8CEBC` | stronger borders / scrollbar |
| `accent` | `#E8664F` | brand coral (CTAs, active, accent bar) |
| `accent-2` | `#F0836F` | coral hover |
| `gold` | `#E3A34C` | ratings / stars / sparkle |
| `wii` | `#4FB8E0` | **the Wii selection blue** (hover glow) |
| `wii-2` | `#8FE0F5` | lighter Wii blue |
| `wii-glow` | `rgba(79,184,224,0.55)` | the glow color for rings/halos |

### Per-title poster pastels (pairs `a`→`b`, used as `linear-gradient(160deg,a,b)`)
Assign one of six deterministically per title (e.g. hash the id % 6):
| class | a | b |
|---|---|---|
| p1 | `#F4A98C` | `#EE8E6C` (peach) |
| p2 | `#ED9DAE` | `#E2879A` (rose) |
| p3 | `#EFCB79` | `#E4B457` (butter) |
| p4 | `#A9CDA0` | `#89B683` (sage) |
| p5 | `#9BCBE0` | `#78B3D0` (sky) |
| p6 | `#F09E86` | `#E27862` (coral) |

## Radius / spacing
- `--r-tile: 16px` (posters, thumbs) · `--r-panel: 22px` (large panels) · hero uses `28px`.
- `--pad: 48px` — the horizontal page rhythm (nav, section headers, rows, library all use it). Drops to `20px` under 820px.
- Pills / chips / buttons: `border-radius: 100px`.

## Typography
- Display / headings: **Zen Maru Gothic** (700; 900 for the biggest). Rounded, friendly — this font is doing a lot of the "Nintendo" work.
- Body / UI: **Plus Jakarta Sans** (400–800).
- Mono (clock, badges, meta, ratings): **JetBrains Mono** (400–500).
- Load weights: Zen Maru 500/700/900, Jakarta 400/500/600/700/800, JetBrains 400/500.

## Easing (critical to the feel)
- `--e-snap: cubic-bezier(.4,1.4,.5,1)` — springy overshoot. Use for **press/hover/pop** on interactive elements.
- `--e: cubic-bezier(.4,0,.2,1)` — standard smooth. Use for **fades/view transitions**.

## Background (the "2007 web" wallpaper)
```css
background-color: #F6F0E6;
background-image:
  radial-gradient(130% 75% at 50% -10%, rgba(255,247,232,0.95), transparent 55%), /* soft warm top light */
  radial-gradient(rgba(120,95,72,0.05) 1px, transparent 1.5px);                    /* faint dot grid */
background-size: 100% 100%, 24px 24px;
background-repeat: no-repeat, repeat;
```

---

## Recipes — the treatments that make it look right

### 1. Glossy plastic sheen (posters, hero, thumbnails)
A single crisp top highlight — **not** a multi-stop gradient. On the art panel:
```css
/* the panel */
box-shadow: inset 0 1.5px 0 rgba(255,255,255,0.6), inset 0 0 0 1px rgba(255,255,255,0.14),
            0 3px 10px -4px rgba(120,80,60,0.28);
/* the sheen (::before) — top 46%, fades out */
content:""; position:absolute; top:0; left:0; right:0; height:46%; z-index:1; pointer-events:none;
background: linear-gradient(rgba(255,255,255,0.42), rgba(255,255,255,0.08) 55%, transparent);
```

### 2. The Wii selection glow (hover on tiles/chips/episodes)
White inner ring + pulsing blue halo. On the poster art:
```css
.tile:hover .art { animation: wiipulse 1.3s ease-in-out infinite; }
@keyframes wiipulse {
  0%,100% { box-shadow: 0 0 0 3px #fff, 0 0 0 5px #4FB8E0, 0 0 15px 1px rgba(79,184,224,.55), 0 14px 26px -8px rgba(120,80,60,.4); }
  50%     { box-shadow: 0 0 0 3px #fff, 0 0 0 6px #4FB8E0, 0 0 26px 4px rgba(79,184,224,.55), 0 14px 26px -8px rgba(120,80,60,.4); }
}
```
Chips (lighter): `box-shadow: 0 0 0 3px rgba(79,184,224,.55); border-color:#4FB8E0;` on hover.
Episode thumb (static, no pulse): `box-shadow: 0 0 0 3px #fff, 0 0 0 5px #4FB8E0, 0 0 16px 1px rgba(79,184,224,.55), 0 8px 16px -6px rgba(120,80,60,.35);`

### 3. Glossy chunky buttons
```css
.btn { border-radius:100px; position:relative; overflow:hidden; }
/* light streak across the top (::after) */
.btn::after { content:""; position:absolute; top:0; left:6%; right:6%; height:46%; pointer-events:none;
  border-radius:100px 100px 60% 60% / 100% 100% 34% 34%;
  background:linear-gradient(rgba(255,255,255,0.5), transparent); }
.btn-primary { background:#fff; color:#E8664F; box-shadow: inset 0 1px 0 rgba(255,255,255,.9), 0 6px 16px -6px rgba(0,0,0,.3); } /* Resume */
.btn-fill    { background:#E8664F; color:#fff; box-shadow: 0 8px 18px -6px rgba(232,102,79,.5); }                                 /* Detail Play */
.btn-glass   { background:rgba(255,255,255,.2); color:#fff; backdrop-filter:blur(6px); border:1px solid rgba(255,255,255,.35); }  /* Details */
```

### 4. Hover lift + 3D tilt (tiles)
- `.tile:hover { transform: translateY(-6px); }` and `.tile:active { transform: translateY(-2px) scale(.98); }` with `--e-snap`.
- The tilt is JS: on pointer-move within a tile, set the **inner `.art`** transform to
  `rotateX(±8deg) rotateY(±8deg)` mapped from cursor position; reset on leave.
  Give `.tile { perspective: 640px; }` and `.art { transform-style:preserve-3d; transition: ...transform .12s ease-out; }`.
  (See `interactions.md` for the exact math and `reference/Tile.tsx` for the React version.)

### 5. Section header accent bar
```css
.sec-head h3 { position:relative; padding-left:15px; font-family:"Zen Maru Gothic"; font-weight:700; }
.sec-head h3::before { content:""; position:absolute; left:0; top:50%; transform:translateY(-50%);
  width:5px; height:19px; border-radius:100px; background:linear-gradient(#E8664F,#F0836F); }
```

### 6. Nav (glossy translucent) + logo shimmer
```css
.nav { background:linear-gradient(rgba(252,247,238,.94), rgba(246,240,230,.86)); backdrop-filter:blur(12px);
  border-bottom:1px solid #E6DDCE; box-shadow: inset 0 1px 0 rgba(255,255,255,.7); height:62px; }
/* brand shimmer sweep every 5s */
.brand-shine { position:absolute; inset:0; pointer-events:none;
  background:linear-gradient(115deg, transparent 42%, rgba(255,255,255,.8) 50%, transparent 58%);
  transform:translateX(-130%); animation:shine 5s ease-in-out infinite; }
@keyframes shine { 0%,72% { transform:translateX(-130%); } 86%,100% { transform:translateX(130%); } }
```

### 7. Hero
Glossy coral panel, `height:340px`, `border-radius:28px`:
```css
background: radial-gradient(circle at 84% 42%, rgba(255,250,235,.6), transparent 46%),
            linear-gradient(115deg, var(--p1a), var(--p1b));
box-shadow: inset 0 2px 0 rgba(255,255,255,.4), 0 10px 30px -12px rgba(120,80,60,.35);
```
- A left-to-right dark scrim (`::after`) for text legibility; text is white.
- The window icon art on the right bobs gently: `@keyframes bob { 0%,100%{translateY(-50%)} 50%{translateY(-58%)} }`.
- Two tiny sparkle "twinkles" pulse in the panel (small, sparse — keep them).

## View transition
`.view.on { animation: zoomin .42s cubic-bezier(.4,0,.2,1); }` with
`@keyframes zoomin { from{opacity:0; transform:scale(.94)} to{opacity:1; transform:scale(1)} }`.
Plus a per-view **stagger** of tiles (see interactions).
