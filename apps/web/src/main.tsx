import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { defaultTheme, lightTheme } from "@hokago/theme";

import "./app.css";
import { WatchPage } from "./WatchPage";
import { BrowsePage } from "./BrowsePage";
import { applyFonts, applyTheme, fetchFonts, THEME_FONTS_TAG_ID, THEME_STYLE_TAG_ID } from "./theme-runtime";

const varStyle = document.createElement("style");
varStyle.id = THEME_STYLE_TAG_ID;
document.head.appendChild(varStyle);
const fontStyle = document.createElement("style");
fontStyle.id = THEME_FONTS_TAG_ID;
document.head.appendChild(fontStyle);

// No per-profile persistence (§15.1) — just a client-side dark/light toggle,
// remembered locally so it survives a reload.
const colorScheme = localStorage.getItem("hokago_color_scheme") === "light" ? "light" : "dark";
const theme = colorScheme === "light" ? lightTheme : defaultTheme;
applyTheme(theme.slug, theme.tokens);
applyFonts(await fetchFonts());

const params = new URLSearchParams(location.search);
const mediaFileId = params.get("mediaFileId");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {mediaFileId ? <WatchPage mediaFileId={mediaFileId} /> : <BrowsePage tokens={theme.tokens} colorScheme={colorScheme} />}
  </StrictMode>,
);
