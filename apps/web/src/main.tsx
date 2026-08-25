import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@vidstack/react/player/styles/default/theme.css";
import "@vidstack/react/player/styles/default/layouts/video.css";
import "./app.css";
import { App } from "./App";
import { applyFonts, fetchFonts, FONTS_STYLE_TAG_ID } from "./fonts-runtime";
import { fetchSetupState } from "./setup-state";
import { ensureDeviceRegistered, startTokenWarmth } from "./native";

const fontStyle = document.createElement("style");
fontStyle.id = FONTS_STYLE_TAG_ID;
document.head.appendChild(fontStyle);

applyFonts(await fetchFonts());
await fetchSetupState();
// Shells keep the access token warm so native downloads never hit a stale
// Authorization header (the bridge mirrors it into platform storage).
startTokenWarmth();
// Backfills a deviceId for a session that predates the shell's clientKey —
// otherwise canDownload() stays false forever and the download button never
// appears, with no way for the user to know why.
void ensureDeviceRegistered();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
