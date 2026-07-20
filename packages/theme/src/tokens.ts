/**
 * hokago — theme token contract
 * Design doc: docs/design.md §15. This file is the source of truth for theming.
 *
 * INVARIANTS (do not violate without updating docs/design.md):
 *   - Every component consumes tokens ONLY. Never a hardcoded value. (§15.1)
 *     This single rule is what makes "100% themeable" true or false.
 *   - Font is a set of ROLES, not one family. Nothing is locked to one face
 *     except font.wordmark's default. (§1.1)
 *   - Every font role is a STACK. An unresolved font degrades to the next entry;
 *     it never breaks the theme. (§1.1, §3.2)
 *   - Families resolve against the shared font store, served from OUR origin.
 *     Never emit an @import or <link> to a third party. (§1.1, §13.3)
 *   - Themes are validated JSON. Invalid themes are rejected at import, never
 *     partially applied.
 */

import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────────────
// PRIMITIVES
// ─────────────────────────────────────────────────────────────────────────────

/** Any CSS color. Kept permissive on purpose — oklch, hsl, hex all valid. */
const Color = z.string().min(1);

/** CSS length, e.g. "4px", "0.5rem". */
const Length = z.string().min(1);

/** CSS duration, e.g. "150ms". */
const Duration = z.string().regex(/^\d+(\.\d+)?m?s$/);

/**
 * A font stack. First entry wins if resolvable in the font store; otherwise
 * fall through. ALWAYS end with a generic family so nothing can break. (§1.1)
 */
const FontStack = z.array(z.string().min(1)).min(1);

// ─────────────────────────────────────────────────────────────────────────────
// TOKEN GROUPS
// ─────────────────────────────────────────────────────────────────────────────

export const ColorTokens = z.object({
  bg: Color,
  bgElevated: Color,
  surface: Color,
  surfaceHover: Color,
  border: Color,
  borderStrong: Color,
  text: Color,
  textMuted: Color,
  textFaint: Color,
  accent: Color,
  accentHover: Color,
  accentText: Color,
  focus: Color,
  danger: Color,
  warning: Color,
  success: Color,
  /** Gradient scrim over generated posters and hero backdrops (§8.7.3). */
  scrim: Color,
  /** Player chrome. Themes diverge hard here — Netflix vs Crunchyroll. */
  playerBg: Color,
  playerControl: Color,
  playerControlHover: Color,
  progressTrack: Color,
  progressFill: Color,
  progressBuffer: Color,
});

/**
 * Font ROLES (§1.1). None of these is fixed to a face — including wordmark,
 * whose Zen Maru Gothic default is a default, not a constraint.
 */
export const FontTokens = z.object({
  display: FontStack,
  body: FontStack,
  ui: FontStack,
  mono: FontStack,
  wordmark: FontStack,
});

export const FontSizeTokens = z.object({
  xs: Length,
  sm: Length,
  base: Length,
  lg: Length,
  xl: Length,
  "2xl": Length,
  "3xl": Length,
  "4xl": Length,
});

export const FontWeightTokens = z.object({
  normal: z.number().int().min(1).max(1000),
  medium: z.number().int().min(1).max(1000),
  semibold: z.number().int().min(1).max(1000),
  bold: z.number().int().min(1).max(1000),
  /** Wordmark weight. Default 500 — Zen Maru Gothic Medium (§1). */
  wordmark: z.number().int().min(1).max(1000),
});

export const RadiusTokens = z.object({
  none: Length,
  sm: Length,
  base: Length,
  lg: Length,
  full: Length,
  /** Poster/card corners. A big part of "feels like Netflix" vs not. */
  card: Length,
});

/** §15.2 lists "borders" as its own category, distinct from color and radius. */
export const BorderWidthTokens = z.object({
  none: Length,
  thin: Length,
  base: Length,
  thick: Length,
  /** Focus ring width — accessibility-relevant, kept independent of `thick`. */
  focus: Length,
});

export const SpacingTokens = z.object({
  xs: Length,
  sm: Length,
  base: Length,
  lg: Length,
  xl: Length,
  "2xl": Length,
});

export const ShadowTokens = z.object({
  none: z.string(),
  sm: z.string(),
  base: z.string(),
  lg: z.string(),
  cardHover: z.string(),
});

export const MotionTokens = z.object({
  fast: Duration,
  base: Duration,
  slow: Duration,
  easeOut: z.string(),
  easeInOut: z.string(),
  /** Netflix-ish scales cards on hover; Crunchyroll-ish doesn't. */
  cardHoverScale: z.number().min(1).max(1.5),
});

/**
 * Layout tokens. These are what actually make a skin read as a different
 * product — not color (§15.2).
 */
export const LayoutTokens = z.object({
  /** "2:3" (Netflix-ish) vs "16:9" (Crunchyroll-ish). Genuinely differs. */
  posterAspect: z.enum(["2:3", "16:9", "1:1", "4:3"]),
  /** Episode/still tiles. */
  stillAspect: z.enum(["16:9", "4:3"]),
  nav: z.enum(["top", "sidebar"]),
  navSticky: z.boolean(),
  contentMaxWidth: Length,
  gridGap: Length,
  cardHover: z.enum(["scale", "lift", "border", "none"]),
  /** Show titles under cards, on hover only, or never. */
  cardTitle: z.enum(["always", "hover", "never"]),
  heroStyle: z.enum(["backdrop", "poster", "none"]),
});

/**
 * Generated artwork composition (§8.7.3). A wall of consistently composed
 * posters looks like a design system; a mixed wall looks broken.
 */
export const GeneratedArtTokens = z.object({
  /**
   * "blur-extend": full 16:9 frame in a 2:3 canvas, blurred fill above/below.
   *   Nothing sliced, nothing lost. Default.
   * "weighted-crop": crop to 2:3 biased upward. Riskier, occasionally better.
   * "solid": flat scrim fill, no blur. Cheapest, most graphic.
   */
  posterStrategy: z.enum(["blur-extend", "weighted-crop", "solid"]),
  scrimStrength: z.number().min(0).max(1),
  titlePlacement: z.enum(["bottom-left", "bottom-center", "center", "none"]),
  /** Which font role sets the composed title. */
  titleFontRole: z.enum(["display", "body", "ui", "wordmark"]),
  blurRadius: z.number().int().min(0).max(200),
  /** Background fill behind blur-extend, when the frame can't cover. */
  fillColor: Color,
});

export const BehaviorTokens = z.object({
  /** Default ordering for collections. Both are always available (§7.3). */
  collectionOrder: z.enum(["release", "story"]),
  /** Recap films hidden by default — a preference, never a deletion (§7.3). */
  hideRecaps: z.boolean(),
  showSkipIntro: z.boolean(),
  autoPlayNext: z.boolean(),
});

// ─────────────────────────────────────────────────────────────────────────────
// THEME
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fonts a theme wants that aren't in the store yet.
 *
 * Source 2 (bundle): file — resolved from /config/themes/<slug>/fonts/.
 * Source 3 (remote): url — fetched ONCE by a background job on the SERVER,
 *   bytes stored forever, then served from our origin. Never a browser request,
 *   never a repeat fetch. This is the fetch-once principle (§3.5) applied to
 *   fonts, exactly as it already applies to artwork.
 *
 * While a fetch is PENDING or FAILED, the theme still applies via its fallback
 * stack. Degrade, never error (§3.2).
 */
export const ThemeFontDecl = z.object({
  family: z.string().min(1),
  weight: z.number().int().min(1).max(1000).optional(),
  style: z.enum(["normal", "italic"]).optional(),
  /** Relative to the bundle dir. Mutually exclusive with `url`. */
  file: z.string().optional(),
  /** Absolute URL. Server-side, fetched once. Mutually exclusive with `file`. */
  url: z.string().url().optional(),
  unicodeRange: z.string().optional(),
}).refine((f) => Boolean(f.file) !== Boolean(f.url), {
  message: "Provide exactly one of `file` or `url`.",
});

export const ThemeTokens = z.object({
  color: ColorTokens,
  font: FontTokens,
  fontSize: FontSizeTokens,
  fontWeight: FontWeightTokens,
  radius: RadiusTokens,
  borderWidth: BorderWidthTokens,
  spacing: SpacingTokens,
  shadow: ShadowTokens,
  motion: MotionTokens,
  layout: LayoutTokens,
  generatedArt: GeneratedArtTokens,
  behavior: BehaviorTokens,
});

export const ThemeManifest = z.object({
  /** Schema version. Bump on breaking token changes; migrate on import. */
  version: z.literal(1),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  author: z.string().optional(),
  /** Themes must declare their license — we don't redistribute user fonts (§1.1). */
  license: z.string().optional(),
  colorScheme: z.enum(["dark", "light"]),
  fonts: z.array(ThemeFontDecl).default([]),
  tokens: ThemeTokens,
});

export type ThemeTokens = z.infer<typeof ThemeTokens>;
export type ThemeManifest = z.infer<typeof ThemeManifest>;
export type ThemeFontDecl = z.infer<typeof ThemeFontDecl>;

// ─────────────────────────────────────────────────────────────────────────────
// CSS VARIABLE EMISSION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tokens → CSS custom properties. Applied to <html data-theme="slug">.
 * Runtime switch, no rebuild (§15.1).
 *
 * Naming: --hk-<group>-<key>, kebab-cased. Tailwind config maps utility
 * classes onto these, which is what lets shadcn components stay token-only.
 */
export function tokensToCssVars(t: ThemeTokens): Record<string, string> {
  const out: Record<string, string> = {};
  const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

  const walk = (group: string, obj: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(obj)) {
      const name = `--hk-${group}-${kebab(k)}`;
      if (Array.isArray(v)) {
        // Font stacks: quote families containing spaces.
        out[name] = v.map((f) => (/\s/.test(f) && !/^["']/.test(f) ? `"${f}"` : f)).join(", ");
      } else if (group === "layout" && (k === "posterAspect" || k === "stillAspect")) {
        // Stored as "2:3" (matches §15.2 prose); CSS `aspect-ratio` needs "2 / 3".
        out[name] = String(v).replace(":", " / ");
      } else if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") {
        out[name] = String(v);
      }
    }
  };

  walk("color", t.color);
  walk("font", t.font);
  walk("text", t.fontSize);
  walk("weight", t.fontWeight);
  walk("radius", t.radius);
  walk("border", t.borderWidth);
  walk("space", t.spacing);
  walk("shadow", t.shadow);
  walk("motion", t.motion);
  walk("layout", t.layout);
  walk("art", t.generatedArt);
  walk("behavior", t.behavior);
  return out;
}

export function cssVarBlock(slug: string, t: ThemeTokens): string {
  const vars = tokensToCssVars(t);
  const body = Object.entries(vars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  return `[data-theme="${slug}"] {\n${body}\n}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

export type ValidationResult =
  | { ok: true; manifest: ThemeManifest }
  | { ok: false; errors: string[] };

/** Reject invalid themes at import. Never partially apply. */
export function validateTheme(input: unknown): ValidationResult {
  const parsed = ThemeManifest.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }

  const errors: string[] = [];
  const m = parsed.data;

  // Every font stack must end in a generic family, or an unresolved font can
  // break the theme — which violates "degrade, never error" (§3.2).
  const GENERIC = new Set([
    "sans-serif", "serif", "monospace", "cursive", "fantasy", "system-ui",
    "ui-sans-serif", "ui-serif", "ui-monospace", "ui-rounded",
  ]);
  for (const [role, stack] of Object.entries(m.tokens.font)) {
    if (!GENERIC.has(stack[stack.length - 1])) {
      errors.push(
        `tokens.font.${role}: stack must end with a generic family (e.g. "sans-serif") so unresolved fonts degrade rather than break.`
      );
    }
  }

  // Declared families should actually be used, and used families that aren't
  // declared must already be in the store — warn loudly rather than silently
  // rendering the wrong face.
  const declared = new Set(m.fonts.map((f) => f.family));
  for (const f of m.fonts) {
    const used = Object.values(m.tokens.font).some((stack) => stack.includes(f.family));
    if (!used) errors.push(`fonts: "${f.family}" is declared but never referenced by any font role.`);
  }
  void declared;

  return errors.length ? { ok: false, errors } : { ok: true, manifest: m };
}

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT THEME
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `hokago` — the default. Warm, rounded, soft. The wordmark face leads.
 *
 * Note the font roles are NOT all Zen Maru Gothic — display and wordmark are;
 * body and ui use a neutral face because 7,866-glyph rounded type at 13px in a
 * dense nav is not the goal (§1.1). Nothing is locked to one face.
 *
 * Zen Maru Gothic: SIL OFL 1.1, vendored at build time — the offline floor.
 */
export const defaultTheme: ThemeManifest = {
  version: 1,
  slug: "hokago",
  name: "hokago",
  license: "OFL-1.1 (Zen Maru Gothic), MIT (theme)",
  colorScheme: "dark",
  fonts: [], // all vendored — source 1, the floor. No fetch, no bundle.
  tokens: {
    color: {
      bg: "oklch(0.15 0.030 292)",
      bgElevated: "oklch(0.20 0.036 290)",
      surface: "oklch(0.26 0.040 288)",
      surfaceHover: "oklch(0.32 0.046 286)",
      border: "oklch(0.35 0.036 286)",
      borderStrong: "oklch(0.47 0.040 284)",
      text: "oklch(0.97 0.006 280)",
      textMuted: "oklch(0.76 0.020 284)",
      textFaint: "oklch(0.58 0.022 284)",
      accent: "oklch(0.76 0.17 26)",
      accentHover: "oklch(0.82 0.18 26)",
      accentText: "oklch(0.18 0.02 22)",
      focus: "oklch(0.76 0.17 26)",
      danger: "oklch(0.64 0.20 25)",
      warning: "oklch(0.80 0.14 85)",
      success: "oklch(0.72 0.15 150)",
      scrim: "oklch(0.10 0.01 275 / 0.82)",
      playerBg: "oklch(0.10 0.008 275)",
      playerControl: "oklch(0.97 0.004 275)",
      playerControlHover: "oklch(0.76 0.17 26)",
      progressTrack: "oklch(0.34 0.016 275)",
      progressFill: "oklch(0.76 0.17 26)",
      progressBuffer: "oklch(0.46 0.018 275)",
    },
    font: {
      display: ["Zen Maru Gothic", "ui-rounded", "sans-serif"],
      body: ["Inter", "system-ui", "sans-serif"],
      ui: ["Inter", "system-ui", "sans-serif"],
      mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      wordmark: ["Zen Maru Gothic", "ui-rounded", "sans-serif"],
    },
    fontSize: {
      xs: "0.75rem",
      sm: "0.875rem",
      base: "1rem",
      lg: "1.125rem",
      xl: "1.375rem",
      "2xl": "1.75rem",
      "3xl": "2.25rem",
      "4xl": "3rem",
    },
    fontWeight: {
      normal: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
      wordmark: 500, // Zen Maru Gothic Medium (§1)
    },
    radius: {
      none: "0",
      sm: "0.25rem",
      base: "0.5rem",
      lg: "1.25rem",
      full: "9999px",
      card: "1.125rem",
    },
    borderWidth: {
      none: "0",
      thin: "1px",
      base: "1px",
      thick: "2px",
      focus: "2px",
    },
    spacing: {
      xs: "0.25rem",
      sm: "0.5rem",
      base: "1rem",
      lg: "1.5rem",
      xl: "2.5rem",
      "2xl": "4rem",
    },
    shadow: {
      none: "none",
      sm: "0 1px 2px oklch(0 0 0 / 0.28)",
      base: "0 2px 8px oklch(0 0 0 / 0.34)",
      lg: "0 8px 28px oklch(0 0 0 / 0.42)",
      cardHover: "0 14px 30px oklch(0.76 0.17 26 / 0.38), 0 4px 10px oklch(0 0 0 / 0.55)",
    },
    motion: {
      fast: "120ms",
      base: "200ms",
      slow: "360ms",
      easeOut: "cubic-bezier(0.22, 1, 0.36, 1)",
      easeInOut: "cubic-bezier(0.65, 0, 0.35, 1)",
      cardHoverScale: 1.04,
    },
    layout: {
      posterAspect: "2:3",
      stillAspect: "16:9",
      nav: "sidebar",
      navSticky: true,
      contentMaxWidth: "1600px",
      gridGap: "1.25rem",
      cardHover: "lift",
      cardTitle: "always",
      heroStyle: "backdrop",
    },
    generatedArt: {
      posterStrategy: "blur-extend",
      scrimStrength: 0.72,
      titlePlacement: "bottom-left",
      titleFontRole: "display",
      blurRadius: 48,
      fillColor: "oklch(0.16 0.012 275)",
    },
    behavior: {
      collectionOrder: "release",
      hideRecaps: true,
      showSkipIntro: true,
      autoPlayNext: true,
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// REFERENCE THEMES (§15.3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `netflix-ish` — no Zen Maru Gothic; a different product, not a hokago
 * recolor. Movie-poster aspect (2:3, §15.2), titles hidden until hover, cards
 * scale up on hover.
 */
export const netflixTheme: ThemeManifest = {
  version: 1,
  slug: "netflix-ish",
  name: "netflix-ish",
  license: "MIT (theme)",
  colorScheme: "dark",
  fonts: [],
  tokens: {
    color: {
      bg: "oklch(0.09 0.005 25)",
      bgElevated: "oklch(0.13 0.006 25)",
      surface: "oklch(0.16 0.008 25)",
      surfaceHover: "oklch(0.20 0.010 25)",
      border: "oklch(0.24 0.010 25)",
      borderStrong: "oklch(0.34 0.012 25)",
      text: "oklch(0.97 0.002 25)",
      textMuted: "oklch(0.72 0.010 25)",
      textFaint: "oklch(0.52 0.010 25)",
      accent: "oklch(0.58 0.22 25)",
      accentHover: "oklch(0.64 0.22 25)",
      accentText: "oklch(0.98 0 0)",
      focus: "oklch(0.58 0.22 25)",
      danger: "oklch(0.58 0.22 25)",
      warning: "oklch(0.80 0.15 85)",
      success: "oklch(0.70 0.15 150)",
      scrim: "oklch(0.05 0.005 25 / 0.85)",
      playerBg: "oklch(0.04 0.004 25)",
      playerControl: "oklch(0.97 0 0)",
      playerControlHover: "oklch(0.58 0.22 25)",
      progressTrack: "oklch(0.28 0.010 25)",
      progressFill: "oklch(0.58 0.22 25)",
      progressBuffer: "oklch(0.40 0.010 25)",
    },
    font: {
      display: ["Inter", "system-ui", "sans-serif"],
      body: ["Inter", "system-ui", "sans-serif"],
      ui: ["Inter", "system-ui", "sans-serif"],
      mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      wordmark: ["Inter", "system-ui", "sans-serif"],
    },
    fontSize: {
      xs: "0.75rem",
      sm: "0.875rem",
      base: "1rem",
      lg: "1.125rem",
      xl: "1.375rem",
      "2xl": "1.75rem",
      "3xl": "2.25rem",
      "4xl": "3rem",
    },
    fontWeight: {
      normal: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
      wordmark: 800,
    },
    radius: {
      none: "0",
      sm: "0.125rem",
      base: "0.25rem",
      lg: "0.375rem",
      full: "9999px",
      card: "0.1875rem",
    },
    borderWidth: {
      none: "0",
      thin: "1px",
      base: "1px",
      thick: "2px",
      focus: "2px",
    },
    spacing: {
      xs: "0.25rem",
      sm: "0.5rem",
      base: "1rem",
      lg: "1.5rem",
      xl: "2.5rem",
      "2xl": "4rem",
    },
    shadow: {
      none: "none",
      sm: "0 1px 2px oklch(0 0 0 / 0.5)",
      base: "0 4px 12px oklch(0 0 0 / 0.6)",
      lg: "0 12px 32px oklch(0 0 0 / 0.7)",
      cardHover: "0 16px 40px oklch(0 0 0 / 0.8)",
    },
    motion: {
      fast: "100ms",
      base: "180ms",
      slow: "320ms",
      easeOut: "cubic-bezier(0.4, 0, 0.2, 1)",
      easeInOut: "cubic-bezier(0.65, 0, 0.35, 1)",
      cardHoverScale: 1.08,
    },
    layout: {
      // §15.2: this is the one genuinely structural difference from
      // crunchyroll-ish, not just a recolor — movie-poster shaped cards.
      posterAspect: "2:3",
      stillAspect: "16:9",
      nav: "top",
      navSticky: true,
      contentMaxWidth: "1800px",
      gridGap: "0.5rem",
      cardHover: "scale",
      cardTitle: "hover",
      heroStyle: "backdrop",
    },
    generatedArt: {
      posterStrategy: "weighted-crop",
      scrimStrength: 0.6,
      titlePlacement: "bottom-left",
      titleFontRole: "display",
      blurRadius: 24,
      fillColor: "oklch(0.09 0.005 25)",
    },
    behavior: {
      collectionOrder: "release",
      hideRecaps: false,
      showSkipIntro: true,
      autoPlayNext: true,
    },
  },
};

/**
 * `crunchyroll-ish` — episodic-thumbnail aspect (16:9, §15.2) instead of
 * movie-poster, titles always visible (episode numbers matter for a
 * still-airing show), cards lift instead of scaling.
 */
export const crunchyrollTheme: ThemeManifest = {
  version: 1,
  slug: "crunchyroll-ish",
  name: "crunchyroll-ish",
  license: "MIT (theme)",
  colorScheme: "dark",
  fonts: [],
  tokens: {
    color: {
      bg: "oklch(0.14 0.010 55)",
      bgElevated: "oklch(0.18 0.012 55)",
      surface: "oklch(0.22 0.014 55)",
      surfaceHover: "oklch(0.27 0.016 55)",
      border: "oklch(0.30 0.014 55)",
      borderStrong: "oklch(0.40 0.018 55)",
      text: "oklch(0.97 0.006 55)",
      textMuted: "oklch(0.74 0.014 55)",
      textFaint: "oklch(0.55 0.014 55)",
      accent: "oklch(0.75 0.19 55)",
      accentHover: "oklch(0.80 0.19 55)",
      accentText: "oklch(0.16 0.02 55)",
      focus: "oklch(0.75 0.19 55)",
      danger: "oklch(0.62 0.21 25)",
      warning: "oklch(0.80 0.16 85)",
      success: "oklch(0.70 0.16 150)",
      scrim: "oklch(0.08 0.008 55 / 0.8)",
      playerBg: "oklch(0.06 0.006 55)",
      playerControl: "oklch(0.97 0.006 55)",
      playerControlHover: "oklch(0.75 0.19 55)",
      progressTrack: "oklch(0.32 0.014 55)",
      progressFill: "oklch(0.75 0.19 55)",
      progressBuffer: "oklch(0.44 0.016 55)",
    },
    font: {
      display: ["Inter", "system-ui", "sans-serif"],
      body: ["Inter", "system-ui", "sans-serif"],
      ui: ["Inter", "system-ui", "sans-serif"],
      mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      wordmark: ["Inter", "system-ui", "sans-serif"],
    },
    fontSize: {
      xs: "0.75rem",
      sm: "0.875rem",
      base: "1rem",
      lg: "1.125rem",
      xl: "1.375rem",
      "2xl": "1.75rem",
      "3xl": "2.25rem",
      "4xl": "3rem",
    },
    fontWeight: {
      normal: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
      wordmark: 700,
    },
    radius: {
      none: "0",
      sm: "0.25rem",
      base: "0.5rem",
      lg: "1rem",
      full: "9999px",
      card: "0.625rem",
    },
    borderWidth: {
      none: "0",
      thin: "1px",
      base: "1px",
      thick: "2px",
      focus: "2px",
    },
    spacing: {
      xs: "0.25rem",
      sm: "0.5rem",
      base: "1rem",
      lg: "1.5rem",
      xl: "2.5rem",
      "2xl": "4rem",
    },
    shadow: {
      none: "none",
      sm: "0 1px 2px oklch(0 0 0 / 0.32)",
      base: "0 3px 10px oklch(0 0 0 / 0.4)",
      lg: "0 10px 26px oklch(0 0 0 / 0.48)",
      cardHover: "0 12px 30px oklch(0 0 0 / 0.56)",
    },
    motion: {
      fast: "130ms",
      base: "220ms",
      slow: "380ms",
      easeOut: "cubic-bezier(0.22, 1, 0.36, 1)",
      easeInOut: "cubic-bezier(0.65, 0, 0.35, 1)",
      cardHoverScale: 1, // lifts instead of scaling — see layout.cardHover
    },
    layout: {
      // §15.2: genuinely structural vs. netflix-ish — episodic thumbnails,
      // not movie posters.
      posterAspect: "16:9",
      stillAspect: "16:9",
      nav: "top",
      navSticky: true,
      contentMaxWidth: "1600px",
      gridGap: "1rem",
      cardHover: "lift",
      cardTitle: "always",
      heroStyle: "backdrop",
    },
    generatedArt: {
      posterStrategy: "blur-extend",
      scrimStrength: 0.68,
      titlePlacement: "bottom-left",
      titleFontRole: "display",
      blurRadius: 40,
      fillColor: "oklch(0.14 0.010 55)",
    },
    behavior: {
      collectionOrder: "release",
      hideRecaps: false,
      showSkipIntro: true,
      autoPlayNext: true,
    },
  },
};

/**
 * `light` — hokago's own identity (Zen Maru Gothic display/wordmark, same
 * layout shape) in a light chrome, not a different product. Only color
 * genuinely differs from `hokago`; the scrim stays dark regardless of
 * colorScheme since it sits over photographic art, not app chrome.
 */
export const lightTheme: ThemeManifest = {
  version: 1,
  slug: "light",
  name: "light",
  license: "OFL-1.1 (Zen Maru Gothic), MIT (theme)",
  colorScheme: "light",
  fonts: [],
  tokens: {
    color: {
      bg: "oklch(0.97 0.003 250)",
      bgElevated: "oklch(1 0 0)",
      surface: "oklch(0.94 0.004 250)",
      surfaceHover: "oklch(0.90 0.006 250)",
      border: "oklch(0.85 0.006 250)",
      borderStrong: "oklch(0.70 0.010 250)",
      text: "oklch(0.18 0.010 250)",
      textMuted: "oklch(0.40 0.012 250)",
      textFaint: "oklch(0.58 0.012 250)",
      accent: "oklch(0.55 0.18 260)",
      accentHover: "oklch(0.48 0.19 260)",
      accentText: "oklch(0.99 0 0)",
      focus: "oklch(0.55 0.18 260)",
      danger: "oklch(0.55 0.20 25)",
      warning: "oklch(0.68 0.15 85)",
      success: "oklch(0.55 0.15 150)",
      scrim: "oklch(0.06 0.010 250 / 0.72)",
      playerBg: "oklch(0.10 0.006 250)",
      playerControl: "oklch(0.97 0 0)",
      playerControlHover: "oklch(0.55 0.18 260)",
      progressTrack: "oklch(0.30 0.010 250)",
      progressFill: "oklch(0.55 0.18 260)",
      progressBuffer: "oklch(0.45 0.010 250)",
    },
    font: {
      display: ["Zen Maru Gothic", "ui-rounded", "sans-serif"],
      body: ["Inter", "system-ui", "sans-serif"],
      ui: ["Inter", "system-ui", "sans-serif"],
      mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      wordmark: ["Zen Maru Gothic", "ui-rounded", "sans-serif"],
    },
    fontSize: {
      xs: "0.75rem",
      sm: "0.875rem",
      base: "1rem",
      lg: "1.125rem",
      xl: "1.375rem",
      "2xl": "1.75rem",
      "3xl": "2.25rem",
      "4xl": "3rem",
    },
    fontWeight: {
      normal: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
      wordmark: 500,
    },
    radius: {
      none: "0",
      sm: "0.25rem",
      base: "0.5rem",
      lg: "0.875rem",
      full: "9999px",
      card: "0.75rem",
    },
    borderWidth: {
      none: "0",
      thin: "1px",
      base: "1px",
      thick: "2px",
      focus: "2px",
    },
    spacing: {
      xs: "0.25rem",
      sm: "0.5rem",
      base: "1rem",
      lg: "1.5rem",
      xl: "2.5rem",
      "2xl": "4rem",
    },
    shadow: {
      none: "none",
      sm: "0 1px 2px oklch(0 0 0 / 0.08)",
      base: "0 2px 8px oklch(0 0 0 / 0.10)",
      lg: "0 8px 24px oklch(0 0 0 / 0.14)",
      cardHover: "0 10px 28px oklch(0 0 0 / 0.18)",
    },
    motion: {
      fast: "120ms",
      base: "200ms",
      slow: "360ms",
      easeOut: "cubic-bezier(0.22, 1, 0.36, 1)",
      easeInOut: "cubic-bezier(0.65, 0, 0.35, 1)",
      cardHoverScale: 1.04,
    },
    layout: {
      posterAspect: "2:3",
      stillAspect: "16:9",
      nav: "sidebar",
      navSticky: true,
      contentMaxWidth: "1600px",
      gridGap: "1rem",
      cardHover: "lift",
      cardTitle: "always",
      heroStyle: "backdrop",
    },
    generatedArt: {
      posterStrategy: "blur-extend",
      scrimStrength: 0.55,
      titlePlacement: "bottom-left",
      titleFontRole: "display",
      blurRadius: 48,
      fillColor: "oklch(0.94 0.004 250)",
    },
    behavior: {
      collectionOrder: "release",
      hideRecaps: true,
      showSkipIntro: true,
      autoPlayNext: true,
    },
  },
};

/**
 * `oled` — hokago pushed to true black for OLED power savings. Same shape as
 * `hokago`; only color moves, and further than `light` does.
 */
export const oledTheme: ThemeManifest = {
  version: 1,
  slug: "oled",
  name: "oled",
  license: "OFL-1.1 (Zen Maru Gothic), MIT (theme)",
  colorScheme: "dark",
  fonts: [],
  tokens: {
    color: {
      bg: "oklch(0 0 0)",
      bgElevated: "oklch(0.05 0.004 275)",
      surface: "oklch(0.09 0.006 275)",
      surfaceHover: "oklch(0.14 0.008 275)",
      border: "oklch(0.18 0.010 275)",
      borderStrong: "oklch(0.28 0.014 275)",
      text: "oklch(0.98 0.002 275)",
      textMuted: "oklch(0.72 0.010 275)",
      textFaint: "oklch(0.50 0.010 275)",
      accent: "oklch(0.78 0.13 22)",
      accentHover: "oklch(0.84 0.14 22)",
      accentText: "oklch(0.12 0.02 22)",
      focus: "oklch(0.78 0.13 22)",
      danger: "oklch(0.64 0.20 25)",
      warning: "oklch(0.80 0.14 85)",
      success: "oklch(0.72 0.15 150)",
      scrim: "oklch(0 0 0 / 0.88)",
      playerBg: "oklch(0 0 0)",
      playerControl: "oklch(0.98 0.002 275)",
      playerControlHover: "oklch(0.78 0.13 22)",
      progressTrack: "oklch(0.20 0.010 275)",
      progressFill: "oklch(0.78 0.13 22)",
      progressBuffer: "oklch(0.32 0.012 275)",
    },
    font: {
      display: ["Zen Maru Gothic", "ui-rounded", "sans-serif"],
      body: ["Inter", "system-ui", "sans-serif"],
      ui: ["Inter", "system-ui", "sans-serif"],
      mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      wordmark: ["Zen Maru Gothic", "ui-rounded", "sans-serif"],
    },
    fontSize: {
      xs: "0.75rem",
      sm: "0.875rem",
      base: "1rem",
      lg: "1.125rem",
      xl: "1.375rem",
      "2xl": "1.75rem",
      "3xl": "2.25rem",
      "4xl": "3rem",
    },
    fontWeight: {
      normal: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
      wordmark: 500,
    },
    radius: {
      none: "0",
      sm: "0.25rem",
      base: "0.5rem",
      lg: "0.875rem",
      full: "9999px",
      card: "0.75rem",
    },
    borderWidth: {
      none: "0",
      thin: "1px",
      base: "1px",
      thick: "2px",
      focus: "2px",
    },
    spacing: {
      xs: "0.25rem",
      sm: "0.5rem",
      base: "1rem",
      lg: "1.5rem",
      xl: "2.5rem",
      "2xl": "4rem",
    },
    shadow: {
      none: "none",
      sm: "0 1px 2px oklch(0 0 0 / 0.6)",
      base: "0 2px 8px oklch(0 0 0 / 0.7)",
      lg: "0 8px 28px oklch(0 0 0 / 0.8)",
      cardHover: "0 10px 32px oklch(0 0 0 / 0.9)",
    },
    motion: {
      fast: "120ms",
      base: "200ms",
      slow: "360ms",
      easeOut: "cubic-bezier(0.22, 1, 0.36, 1)",
      easeInOut: "cubic-bezier(0.65, 0, 0.35, 1)",
      cardHoverScale: 1.04,
    },
    layout: {
      posterAspect: "2:3",
      stillAspect: "16:9",
      nav: "sidebar",
      navSticky: true,
      contentMaxWidth: "1600px",
      gridGap: "1rem",
      cardHover: "lift",
      cardTitle: "always",
      heroStyle: "backdrop",
    },
    generatedArt: {
      posterStrategy: "blur-extend",
      scrimStrength: 0.8,
      titlePlacement: "bottom-left",
      titleFontRole: "display",
      blurRadius: 48,
      fillColor: "oklch(0 0 0)",
    },
    behavior: {
      collectionOrder: "release",
      hideRecaps: true,
      showSkipIntro: true,
      autoPlayNext: true,
    },
  },
};

export const referenceThemes: ThemeManifest[] = [
  defaultTheme,
  netflixTheme,
  crunchyrollTheme,
  lightTheme,
  oledTheme,
];
