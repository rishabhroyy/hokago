# Component breakdown

The prototype is one HTML file with four `<section class="view">` blocks and a fixed nav.
Decompose like this (names are suggestions — match repo conventions). Everything is
data-driven; the prototype's hardcoded titles become props from the API.

## Tree
```
<App>                         // routing + which view is active; owns the sound context
├─ <TopNav>                   // fixed chrome (hidden on Player)
│   ├─ <Brand onHome/>        // logo button → home, with shimmer sweep
│   ├─ <NavLinks/>            // Home / Library / Anime / Movies (active state)
│   ├─ <Clock/>               // live monospace clock (setInterval)
│   ├─ <SearchExpand/>        // icon that expands to an input
│   ├─ <SoundToggle/>         // speaker/mute; drives the sound context
│   └─ <Avatar/>
├─ <HomeView>
│   ├─ <Hero item/>           // featured/continue title
│   └─ <Row title items/>*    // "Continue watching", "Recently added", "Because you watched X"
│       └─ <Tile item/>*      // the atom
├─ <LibraryView>
│   ├─ <Chips value onChange/>
│   └─ <Grid> <Tile/>* </Grid>
├─ <DetailView item/>
│   ├─ banner + <Poster/>
│   ├─ actions: <Button variant="fill">Play</> +List +Download
│   ├─ <SubDubToggle/>
│   └─ <EpisodeGrid episodes/>  // episode cards reuse the Wii-glow
└─ <PlayerView item episode/>    // Vidstack, custom skin
```

## Prop shapes (adapt to the real Prisma types)
```ts
type PosterHue = 1|2|3|4|5|6;               // deterministic per title (hash id % 6)+1

interface TitleCard {
  id: string;
  title: string;
  kind: "Anime · TV" | "Movie" | "OVA" | "Show" | string;  // shown as .t-sub
  iconName: IconName;      // the line-art glyph shown on the poster (window, music, teacup, …)
  hue: PosterHue;          // which pastel pair
  rating?: number;         // shows the gold star badge
  badge?: string;          // "NEW", "4K", "S2·E4", "OVA", "SUB", "DUB"
  progress?: number;       // 0..1 → the bottom progress bar (continue-watching)
}

interface HeroItem extends TitleCard {
  eyebrow: string;         // "Continue watching"
  year: string; meta: string; remaining?: string;
  resumeHref: string; detailHref: string;
}

interface Episode {
  id: string; number: number; title: string; durationMin: number;
  hue: PosterHue; iconName: IconName; watched?: boolean;
}
```

## Notes per component
- **Tile** — the most important atom. 2:3 art panel (pastel by `hue`), centered line-art
  icon, optional top-left badge + top-right gold rating + bottom progress bar, label +
  sub below. Hover = lift + tilt + Wii-glow; click = channel-zoom → detail. See
  `reference/Tile.tsx`.
- **Row** — a horizontal `overflow-x` scroller with **top padding ~28px** so lifted/tilted
  tiles don't clip (the scroller clips vertically too). Gutter arrow buttons appear on row
  hover and call `scrollBy({left: ±540, behavior:'smooth'})`.
- **Hero** — glossy coral panel; put the featured title's own `hue` as the panel gradient
  for variety, or keep p1 as in the prototype. Buttons: Resume = `btn-primary` (white
  glossy), Details = `btn-glass`.
- **SubDub / Chips** — single-select pill groups; selected = filled coral, rest = outline.
- **EpisodeGrid** — 16:9 cards, same gloss + Wii-glow-on-hover, EP# badge / duration /
  watched check.
- **PlayerView** — replace the mock with **Vidstack**. Recreate the control bar styling:
  coral scrub with a white knob (4px glow ring), pill icon-buttons, top-left back +
  breadcrumb, top-right watch-party chip. Hide `<TopNav>` while this view is active.
- **Clock** — `setInterval(…, 10000)`; **clear on unmount**. Format `h:mm AM/PM`.

## Routing
The prototype fakes views with a `showView(name)` function toggling an `.on` class. In the
app use the real router. Two behaviors to preserve on navigation:
1. hide the nav on the player route,
2. run the stagger-in animation for the entering view (see interactions).
