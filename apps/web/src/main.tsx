import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { cssVarBlock, defaultTheme, type ThemeTokens } from "@hokago/theme";

import "./app.css";
import { WatchPage } from "./WatchPage";
import { ThemeDemo } from "./ThemeDemo";
import { BrowsePage } from "./BrowsePage";
import {
  applyThemeFonts,
  applyWordmarkFont,
  fetchThemeFonts,
  fetchThemeList,
  fetchWordmarkFont,
  THEME_FONTS_TAG_ID,
  THEME_STYLE_TAG_ID,
  WORDMARK_FONT_TAG_ID,
} from "./theme-runtime";

// Non-negotiable #6: every value the page uses comes from theme tokens, not a
// hardcoded color/font/radius. Full theme switcher UI is Step 10 — this just
// makes Profile.themeId actually take effect: resolve the profile's assigned
// theme and inject its tokens, falling back to the vendored default if the
// profile has none set or the fetch fails (local-first — never block render
// on network for this).
async function resolveTokens(profileId: string | null): Promise<{ id: string | null; slug: string; tokens: ThemeTokens }> {
  if (!profileId) return { id: null, slug: defaultTheme.slug, tokens: defaultTheme.tokens };
  try {
    // No login UI yet (out of scope for this step) — the access token is
    // stashed in localStorage by whatever flow authenticated the account.
    const accessToken = localStorage.getItem("hokago_access_token");
    const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined;
    const profile = await fetch(`/profiles/${profileId}`, { headers }).then((r) => (r.ok ? r.json() : null));
    if (!profile?.themeId) return { id: null, slug: defaultTheme.slug, tokens: defaultTheme.tokens };
    const theme = await fetch(`/themes/${profile.themeId}`).then((r) => (r.ok ? r.json() : null));
    if (!theme) return { id: null, slug: defaultTheme.slug, tokens: defaultTheme.tokens };
    return { id: theme.id, slug: theme.slug, tokens: theme.tokens };
  } catch {
    return { id: null, slug: defaultTheme.slug, tokens: defaultTheme.tokens };
  }
}

const params = new URLSearchParams(location.search);
const mediaFileId = params.get("mediaFileId");
const profileId = params.get("profileId");

const { id, slug, tokens } = await resolveTokens(profileId);
const varStyle = document.createElement("style");
varStyle.id = THEME_STYLE_TAG_ID;
varStyle.textContent = cssVarBlock(slug, tokens);
document.head.appendChild(varStyle);
const fontStyle = document.createElement("style");
fontStyle.id = THEME_FONTS_TAG_ID;
document.head.appendChild(fontStyle);
const wordmarkFontStyle = document.createElement("style");
wordmarkFontStyle.id = WORDMARK_FONT_TAG_ID;
document.head.appendChild(wordmarkFontStyle);
document.documentElement.dataset.theme = slug;

// The vendored default has no DB row until boot-seeded; resolve its id from
// the theme list rather than hardcoding one, so this still works before a
// profile/theme has ever been assigned.
const initialThemeId = id ?? (await fetchThemeList()).find((t) => t.slug === slug)?.id ?? null;
if (initialThemeId) applyThemeFonts(await fetchThemeFonts(initialThemeId));
// Independent of theme switching (§1) — the wordmark face never changes.
applyWordmarkFont(await fetchWordmarkFont());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {mediaFileId ? (
      <WatchPage mediaFileId={mediaFileId} />
    ) : params.has("demo") ? (
      <ThemeDemo initialSlug={slug} initialTokens={tokens} />
    ) : (
      <BrowsePage tokens={tokens} />
    )}
  </StrictMode>,
);
