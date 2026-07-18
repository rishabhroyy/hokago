import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";

export type NfoKind = "movie" | "tvshow" | "episodedetails";

export interface ParsedNfo {
  kind: NfoKind;
  title: string | null;
  year: number | null;
  plot: string | null;
  uniqueIds: { provider: string; id: string }[];
}

const NFO_KINDS: NfoKind[] = ["movie", "tvshow", "episodedetails"];

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

/**
 * Parses a Kodi NFO. Returns null for anything that isn't actually one —
 * critically, scene-release `.nfo` files are ASCII-art release notes that
 * share the extension but aren't XML at all (§9.3 known-unresolvable case:
 * "detect and ignore. Real bug we'd otherwise ship.").
 */
export function parseNfo(xml: string): ParsedNfo | null {
  if (XMLValidator.validate(xml) !== true) return null;

  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml);
  } catch {
    return null;
  }

  const kind = NFO_KINDS.find((k) => k in doc);
  if (!kind) return null;

  const root = doc[kind] as Record<string, unknown>;

  const uniqueIds: { provider: string; id: string }[] = [];
  const rawUniqueIds = root.uniqueid;
  const uniqueIdList = Array.isArray(rawUniqueIds) ? rawUniqueIds : rawUniqueIds ? [rawUniqueIds] : [];
  for (const entry of uniqueIdList) {
    if (typeof entry === "object" && entry !== null) {
      const e = entry as Record<string, unknown>;
      const provider = typeof e["@_type"] === "string" ? e["@_type"] : null;
      const id = typeof e["#text"] === "string" ? e["#text"] : typeof e["#text"] === "number" ? String(e["#text"]) : null;
      if (provider && id) uniqueIds.push({ provider, id });
    }
  }
  // Older Kodi form: bare <id>tt1234567</id>, always imdb.
  if (uniqueIds.length === 0 && typeof root.id === "string" && root.id.startsWith("tt")) {
    uniqueIds.push({ provider: "imdb", id: root.id });
  }

  const title = typeof root.title === "string" ? root.title : null;
  const yearRaw = root.year;
  const year = typeof yearRaw === "number" ? yearRaw : typeof yearRaw === "string" ? Number.parseInt(yearRaw, 10) : null;
  const plot = typeof root.plot === "string" ? root.plot : null;

  return { kind, title, year: year && !Number.isNaN(year) ? year : null, plot, uniqueIds };
}

/** Candidate NFO paths for a given video file, per §10.1 conventions. */
export async function findNfoForFile(filePath: string): Promise<ParsedNfo | null> {
  const dir = path.dirname(filePath);
  const base = filePath.replace(/\.[^.]+$/, "");
  const candidates = [`${base}.nfo`, path.join(dir, "movie.nfo"), path.join(dir, "tvshow.nfo")];

  for (const candidate of candidates) {
    try {
      const xml = await readFile(candidate, "utf-8");
      const parsed = parseNfo(xml);
      if (parsed) return parsed;
    } catch {
      // file doesn't exist or isn't readable — try the next candidate
    }
  }
  return null;
}

export async function listNfoFilesInDir(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".nfo")).map((e) => path.join(dir, e.name));
}
