import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./app.css";
import { WatchPage } from "./WatchPage";
import { BrowsePage } from "./BrowsePage";
import { applyFonts, fetchFonts, FONTS_STYLE_TAG_ID } from "./fonts-runtime";

const fontStyle = document.createElement("style");
fontStyle.id = FONTS_STYLE_TAG_ID;
document.head.appendChild(fontStyle);

applyFonts(await fetchFonts());

const params = new URLSearchParams(location.search);
const mediaFileId = params.get("mediaFileId");

createRoot(document.getElementById("root")!).render(
  <StrictMode>{mediaFileId ? <WatchPage mediaFileId={mediaFileId} /> : <BrowsePage />}</StrictMode>,
);
