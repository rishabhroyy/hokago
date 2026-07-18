import type { ContentProfile } from "@hokago/db";

import { parseAnime } from "./parsers/anime.js";
import { parseScene } from "./parsers/scene.js";
import type { ParsedFilename } from "./parsers/types.js";

export type { ParsedFilename } from "./parsers/types.js";

/** Parser registry (§9.3): forks by library content profile. */
export function parseFilename(filename: string, profile: ContentProfile = "GENERAL"): ParsedFilename {
  return profile === "ANIME" ? parseAnime(filename) : parseScene(filename);
}
