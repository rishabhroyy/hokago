import { cssVarBlock, type ThemeTokens } from "@hokago/theme";

export const THEME_STYLE_TAG_ID = "hk-theme-vars";

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

/** Runtime switch, no rebuild (§15.1) — swap the injected var block and data-theme. */
export function applyTheme(slug: string, tokens: ThemeTokens): void {
  const style = document.getElementById(THEME_STYLE_TAG_ID) as HTMLStyleElement | null;
  if (style) style.textContent = cssVarBlock(slug, tokens);
  document.documentElement.dataset.theme = slug;
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
