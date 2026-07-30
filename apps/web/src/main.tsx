import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@vidstack/react/player/styles/default/theme.css";
import "@vidstack/react/player/styles/default/layouts/video.css";
import "./app.css";
import { App } from "./App";
import { applyFonts, fetchFonts, FONTS_STYLE_TAG_ID } from "./fonts-runtime";

const fontStyle = document.createElement("style");
fontStyle.id = FONTS_STYLE_TAG_ID;
document.head.appendChild(fontStyle);

applyFonts(await fetchFonts());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
