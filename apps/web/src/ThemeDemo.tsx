import { useEffect, useState } from "react";
import type { ThemeTokens } from "@hokago/theme";
import { applyTheme, fetchTheme, fetchThemeList, type ThemeSummary } from "./theme-runtime";

interface ThemeDemoProps {
  initialSlug: string;
  initialTokens: ThemeTokens;
}

// Step 10 verification surface: a live switcher proving runtime theming
// actually re-renders, plus a poster grid proving the §15.2 posterAspect
// structural difference (2:3 vs 16:9), not just that tokens differ in the DB.
export function ThemeDemo({ initialSlug, initialTokens }: ThemeDemoProps) {
  const [themes, setThemes] = useState<ThemeSummary[]>([]);
  const [slug, setSlug] = useState(initialSlug);
  const [tokens, setTokens] = useState(initialTokens);

  useEffect(() => {
    fetchThemeList().then(setThemes);
  }, []);

  const handleSelect = async (id: string) => {
    const theme = await fetchTheme(id);
    if (!theme) return;
    applyTheme(theme.slug, theme.tokens);
    setSlug(theme.slug);
    setTokens(theme.tokens);
  };

  const { layout } = tokens;

  return (
    <div style={{ padding: "var(--hk-space-lg)", color: "var(--hk-color-text)", fontFamily: "var(--hk-font-ui)" }}>
      <h1 style={{ fontFamily: "var(--hk-font-display)" }}>hokago — theme demo</h1>
      <p>
        Add <code>?mediaFileId=&lt;id&gt;</code> to the URL to watch instead. Stand-in for the
        profile-menu switcher (§15.3) — swaps <code>data-theme</code> and the injected token block
        live, no reload.
      </p>
      <label>
        theme:{" "}
        <select value={themes.find((t) => t.slug === slug)?.id ?? ""} onChange={(e) => handleSelect(e.target.value)}>
          {themes.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.colorScheme.toLowerCase()})
            </option>
          ))}
        </select>
      </label>
      <p style={{ color: "var(--hk-color-text-muted)", fontSize: "var(--hk-text-sm)" }} data-testid="token-readout">
        slug: {slug} · nav: {layout.nav} · posterAspect: {layout.posterAspect} · cardHover: {layout.cardHover} ·
        cardTitle: {layout.cardTitle}
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
          gap: "var(--hk-layout-grid-gap)",
          marginTop: "var(--hk-space-base)",
        }}
      >
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column" }}>
            <div
              data-testid="poster"
              style={{
                aspectRatio: "var(--hk-layout-poster-aspect)",
                background: "var(--hk-color-surface)",
                border: "var(--hk-border-base) solid var(--hk-color-border)",
                borderRadius: "var(--hk-radius-card)",
                boxShadow: "var(--hk-shadow-base)",
                transition: "transform var(--hk-motion-base) var(--hk-motion-ease-out)",
              }}
            />
            {layout.cardTitle === "always" && (
              <span style={{ fontSize: "var(--hk-text-sm)", marginTop: "var(--hk-space-xs)" }}>Poster {i + 1}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
