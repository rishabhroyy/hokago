import { cssVarBlock, type ThemeTokens } from "@hokago/theme";

export const THEME_STYLE_TAG_ID = "hk-theme-vars";
export const THEME_FONTS_TAG_ID = "hk-theme-fonts";
// Always-on, independent of theme switching — the wordmark face is fixed
// brand identity (§1), not a swappable font.wordmark token.
export const WORDMARK_FONT_TAG_ID = "hk-wordmark-font";

export interface ThemeSummary {
  id: string;
  slug: string;
  name: string;
  colorScheme: "DARK" | "LIGHT";
}

export interface ThemeDetail {
  id: string;
  slug: string;
  tokens: ThemeTokens;
}

export interface ThemeFontDescriptor {
  hash: string;
  family: string;
  weight: number | null;
  style: string | null;
  url: string;
}

/** Runtime switch, no rebuild (§15.1) — swap the injected var block and data-theme. */
export function applyTheme(slug: string, tokens: ThemeTokens): void {
  const style = document.getElementById(THEME_STYLE_TAG_ID) as HTMLStyleElement | null;
  if (style) style.textContent = cssVarBlock(slug, tokens);
  document.documentElement.dataset.theme = slug;
}

/**
 * Fonts are served from our own origin, byte-for-byte, via the same
 * hash-addressed store subtitle fonts use (§1.1, §13.3) — never a
 * third-party @import or <link>. Missing/failed fonts just fall through to
 * the stack's next member; nothing here can break the page (§3.2).
 */
function fontFaceCss(fonts: ThemeFontDescriptor[]): string {
  return fonts
    .map(
      (f) =>
        `@font-face { font-family: "${f.family}"; font-weight: ${f.weight ?? 400}; font-style: ${f.style ?? "normal"}; src: url("${f.url}") format("woff2"); font-display: swap; }`,
    )
    .join("\n");
}

export function applyThemeFonts(fonts: ThemeFontDescriptor[]): void {
  const style = document.getElementById(THEME_FONTS_TAG_ID) as HTMLStyleElement | null;
  if (!style) return;
  style.textContent = fontFaceCss(fonts);
}

export function applyWordmarkFont(fonts: ThemeFontDescriptor[]): void {
  const style = document.getElementById(WORDMARK_FONT_TAG_ID) as HTMLStyleElement | null;
  if (!style) return;
  style.textContent = fontFaceCss(fonts);
}

export async function fetchThemeList(): Promise<ThemeSummary[]> {
  const res = await fetch("/themes");
  if (!res.ok) return [];
  return res.json();
}

export async function fetchTheme(id: string): Promise<ThemeDetail | null> {
  const res = await fetch(`/themes/${id}`);
  return res.ok ? res.json() : null;
}

export async function fetchThemeFonts(id: string): Promise<ThemeFontDescriptor[]> {
  const res = await fetch(`/themes/${id}/fonts`);
  if (!res.ok) return [];
  return res.json();
}

export async function fetchWordmarkFont(): Promise<ThemeFontDescriptor[]> {
  const res = await fetch("/fonts/wordmark");
  if (!res.ok) return [];
  return res.json();
}
