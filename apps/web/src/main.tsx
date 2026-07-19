import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { cssVarBlock, defaultTheme, type ThemeTokens } from "@hokago/theme";

import "./app.css";
import { WatchPage } from "./WatchPage";

// Non-negotiable #6: every value the page uses comes from theme tokens, not a
// hardcoded color/font/radius. Full theme switcher UI is Step 10 — this just
// makes Profile.themeId actually take effect: resolve the profile's assigned
// theme and inject its tokens, falling back to the vendored default if the
// profile has none set or the fetch fails (local-first — never block render
// on network for this).
async function resolveTokens(profileId: string | null): Promise<{ slug: string; tokens: ThemeTokens }> {
  if (!profileId) return { slug: defaultTheme.slug, tokens: defaultTheme.tokens };
  try {
    // No login UI yet (out of scope for this step) — the access token is
    // stashed in localStorage by whatever flow authenticated the account.
    const accessToken = localStorage.getItem("hokago_access_token");
    const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined;
    const profile = await fetch(`/profiles/${profileId}`, { headers }).then((r) => (r.ok ? r.json() : null));
    if (!profile?.themeId) return { slug: defaultTheme.slug, tokens: defaultTheme.tokens };
    const theme = await fetch(`/themes/${profile.themeId}`).then((r) => (r.ok ? r.json() : null));
    if (!theme) return { slug: defaultTheme.slug, tokens: defaultTheme.tokens };
    return { slug: theme.slug, tokens: theme.tokens };
  } catch {
    return { slug: defaultTheme.slug, tokens: defaultTheme.tokens };
  }
}

const params = new URLSearchParams(location.search);
const mediaFileId = params.get("mediaFileId");
const profileId = params.get("profileId");

const { slug, tokens } = await resolveTokens(profileId);
const style = document.createElement("style");
style.textContent = cssVarBlock(slug, tokens);
document.head.appendChild(style);
document.documentElement.dataset.theme = slug;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {mediaFileId ? (
      <WatchPage mediaFileId={mediaFileId} />
    ) : (
      <p style={{ padding: "var(--hk-space-lg)", color: "var(--hk-color-text)" }}>
        Add <code>?mediaFileId=&lt;id&gt;</code> to the URL.
      </p>
    )}
  </StrictMode>,
);
