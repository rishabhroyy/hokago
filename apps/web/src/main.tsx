import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { cssVarBlock, defaultTheme } from "@hokago/theme";

import "./app.css";
import { WatchPage } from "./WatchPage";

// Non-negotiable #6: every value the page uses comes from theme tokens, not a
// hardcoded color/font/radius. Full theme switcher UI is Step 10 — this just
// injects the one (default) theme's CSS vars under its own [data-theme] scope.
const style = document.createElement("style");
style.textContent = cssVarBlock(defaultTheme.slug, defaultTheme.tokens);
document.head.appendChild(style);
document.documentElement.dataset.theme = defaultTheme.slug;

const mediaFileId = new URLSearchParams(location.search).get("mediaFileId");

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
