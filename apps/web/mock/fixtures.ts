// Fake API responses for `pnpm dev:web:mock` — typed against the contract so
// a schema change breaks `pnpm --filter @hokago/web typecheck`, not the preview.
// Artwork URLs point at /artwork/mock/*, which plugin.ts renders as SVG.
import type { MediaCard, MediaItemDetail, EpisodeCard, LibrarySummary, MediaFileDescriptor } from "@hokago/contract/browse";
import type { HomeResponse } from "@hokago/contract/home";
import type { ContinueWatchingEntry } from "@hokago/contract/playback";
import type { Profile } from "@hokago/contract/profiles";
import type {
  AdminSummary,
  AdminLibrary,
  AdminAccount,
  AdminInvite,
  AdminSession,
  ServerSettings,
  AttentionItem,
  AdminHwaccelStatus,
} from "@hokago/contract/admin";

const now = new Date("2026-10-20T20:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
const art = (id: string, shape: "poster" | "backdrop") => `/artwork/mock/${shape}/${encodeURIComponent(id)}`;

type Seed = [id: string, title: string, year: number, kind: "SERIES" | "MOVIE", genres: string[], lib: "anime" | "tv" | "movies"];
const SEEDS: Seed[] = [
  ["frieren", "Frieren: Beyond Journey's End", 2023, "SERIES", ["Adventure", "Fantasy"], "anime"],
  ["bocchi", "Bocchi the Rock!", 2022, "SERIES", ["Comedy", "Music"], "anime"],
  ["spice", "Spice and Wolf", 2008, "SERIES", ["Romance", "Fantasy"], "anime"],
  ["haruhi", "The Melancholy of Haruhi Suzumiya", 2006, "SERIES", ["Comedy", "Sci-Fi"], "anime"],
  ["kon", "K-On!", 2009, "SERIES", ["Comedy", "Slice of Life"], "anime"],
  ["violet", "Violet Evergarden", 2018, "SERIES", ["Drama", "Fantasy"], "anime"],
  ["hyouka", "Hyouka", 2012, "SERIES", ["Mystery", "Slice of Life"], "anime"],
  ["bunny", "Rascal Does Not Dream of Bunny Girl Senpai", 2018, "SERIES", ["Romance", "Drama"], "anime"],
  ["silent", "A Silent Voice", 2016, "MOVIE", ["Drama"], "anime"],
  ["yourname", "Your Name.", 2016, "MOVIE", ["Romance", "Drama"], "anime"],
  ["severance", "Severance", 2022, "SERIES", ["Drama", "Mystery"], "tv"],
  ["bear", "The Bear", 2022, "SERIES", ["Comedy", "Drama"], "tv"],
  ["andor", "Andor", 2022, "SERIES", ["Sci-Fi", "Drama"], "tv"],
  ["shogun", "Shōgun", 2024, "SERIES", ["Drama", "History"], "tv"],
  ["paddington", "Paddington 2", 2017, "MOVIE", ["Comedy", "Family"], "movies"],
  ["arrival", "Arrival", 2016, "MOVIE", ["Sci-Fi", "Drama"], "movies"],
  ["perfectdays", "Perfect Days", 2023, "MOVIE", ["Drama"], "movies"],
  ["pastlives", "Past Lives", 2023, "MOVIE", ["Romance", "Drama"], "movies"],
  ["dune2", "Dune: Part Two", 2024, "MOVIE", ["Sci-Fi", "Adventure"], "movies"],
  ["noart", "A Title With No Artwork At All", 2020, "MOVIE", ["Drama"], "movies"],
];

const card = ([id, title, year, kind, genres]: Seed, i: number): MediaCard => ({
  id,
  kind,
  title,
  sortTitle: title.replace(/^(The|A) /, ""),
  year,
  // one deliberately art-less title, to preview the pastel fallback tile
  posterUrl: id === "noart" ? null : art(id, "poster"),
  backdropUrl: id === "noart" ? null : art(id, "backdrop"),
  mediaFileId: kind === "MOVIE" ? `file-${id}` : null,
  isDownloaded: id !== "noart", // "has files on disk" — false previews the not-downloaded detail
  genres,
  createdAt: daysAgo(i * 3),
});

export const cards = SEEDS.map(card);
const byLib = (lib: Seed[5]) => SEEDS.flatMap((s, i) => (s[5] === lib ? [cards[i]] : []));

export const libraries: LibrarySummary[] = [
  { id: "anime", name: "Anime", contentProfile: "ANIME", mediaKinds: ["SERIES", "MOVIE"] },
  { id: "tv", name: "TV Shows", contentProfile: "GENERAL", mediaKinds: ["SERIES"] },
  { id: "movies", name: "Movies", contentProfile: "GENERAL", mediaKinds: ["MOVIE"] },
];
export const libraryItems: Record<string, MediaCard[]> = {
  anime: byLib("anime"),
  tv: byLib("tv"),
  movies: byLib("movies"),
};

const EP_NAMES = ["The Journey's End", "It Didn't Have to Be Magic", "Killing Magic", "The Land Where Souls Rest", "Phantoms of the Dead", "The Hero of the Village", "Like a Fairy Tale", "Frieren the Slayer"];
function episodes(series: MediaCard): EpisodeCard[] {
  return EP_NAMES.map((name, i) => ({
    ...series,
    id: `${series.id}-e${i + 1}`,
    kind: "EPISODE",
    title: name,
    sortTitle: name,
    posterUrl: series.backdropUrl,
    mediaFileId: `file-${series.id}-e${i + 1}`,
    seasonNumber: 1,
    episodeNumber: i + 1,
    runtimeMs: 24 * 60_000,
    watched: i < 3,
    positionMs: i === 3 ? 11 * 60_000 : 0,
  }));
}

export function detail(id: string): MediaItemDetail | null {
  const c = cards.find((x) => x.id === id) ?? cards.find((x) => id.startsWith(`${x.id}-e`));
  if (!c) return null;
  const isSeries = c.kind === "SERIES";
  return {
    ...c,
    overview:
      "After the party of heroes defeats the Demon King, the elf mage among them outlives her companions and sets out to understand the humans she barely got to know. A quiet, patient story about time, memory, and what it means to have mattered to someone.",
    originalTitle: isSeries ? "葬送のフリーレン" : null,
    rating: 8.9,
    studio: "Madhouse",
    children: [],
    episodes: isSeries ? episodes(c) : [],
    movies: [],
    audioTracks: [
      { streamIndex: 1, lang: "jpn" },
      { streamIndex: 2, lang: "eng" },
    ],
    bitrateKbps: 8200,
    bitrateQuality: "good",
    watch: isSeries ? null : { watched: false, positionMs: 32 * 60_000, durationMs: 118 * 60_000, playCount: 0, lastWatchedAt: daysAgo(1) },
    externalIds: [{ provider: "ANILIST", providerId: "154587" }],
    collections: [],
  };
}

export const files: MediaFileDescriptor[] = [
  {
    mediaFileId: "file-x",
    isPrimary: true,
    container: "matroska",
    durationMs: 24 * 60_000,
    sizeBytes: 1_400_000_000,
    bitrate: 8_200_000,
    video: { codec: "hevc", width: 1920, height: 1080, frameRate: 23.976, isHdr: false },
    audioTracks: [],
    subtitleTracks: [],
  },
];

const cw = (c: MediaCard, ep: number | null, pos: number, upNext = false): ContinueWatchingEntry => ({
  mediaItem: {
    id: ep ? `${c.id}-e${ep}` : c.id,
    kind: ep ? "EPISODE" : c.kind,
    title: ep ? EP_NAMES[ep - 1] : c.title,
    sortTitle: c.sortTitle,
    parentId: ep ? c.id : null,
    seasonNumber: ep ? 1 : null,
    episodeNumber: ep,
    year: c.year,
    posterUrl: c.posterUrl,
    backdropUrl: c.backdropUrl,
    mediaFileId: ep ? `file-${c.id}-e${ep}` : c.mediaFileId,
  },
  seriesTitle: ep ? c.title : null,
  detailItemId: c.id,
  positionMs: pos,
  durationMs: ep ? 24 * 60_000 : 118 * 60_000,
  upNext,
});

const card$ = (id: string) => cards.find((c) => c.id === id)!;
export const continueWatching: ContinueWatchingEntry[] = [
  cw(card$("frieren"), 4, 11 * 60_000),
  cw(card$("arrival"), null, 32 * 60_000),
  cw(card$("bocchi"), 7, 0, true),
  cw(card$("severance"), 2, 40 * 60_000),
];

export const home: HomeResponse = {
  continueWatching,
  slides: [
    {
      kind: "CONTINUE",
      label: "Continue watching",
      title: "Frieren: Beyond Journey's End",
      sub: "S1 · E4 · The Land Where Souls Rest",
      year: 2023,
      posterUrl: card$("frieren").posterUrl,
      backdropUrl: card$("frieren").backdropUrl,
      progress: 0.46,
      timeLeftLabel: "13 min left",
      detailId: "frieren",
      mediaItemId: "frieren-e4",
      mediaFileId: "file-frieren-e4",
    },
    {
      kind: "THIS_SEASON",
      label: "This season",
      title: "The Apothecary Diaries",
      sub: "Mystery · Drama",
      year: 2025,
      posterUrl: art("apothecary", "poster"),
      backdropUrl: art("apothecary", "backdrop"),
      progress: null,
      timeLeftLabel: null,
      detailId: null,
      mediaItemId: null,
      mediaFileId: null,
    },
    {
      kind: "RECENTLY_ADDED",
      label: "Recently added",
      title: "Perfect Days",
      sub: "Drama",
      year: 2023,
      posterUrl: card$("perfectdays").posterUrl,
      backdropUrl: card$("perfectdays").backdropUrl,
      progress: null,
      timeLeftLabel: null,
      detailId: "perfectdays",
      mediaItemId: "perfectdays",
      mediaFileId: "file-perfectdays",
    },
  ],
  rows: [
    { id: "recent", title: "Recently added", subtitle: null, items: [...cards].sort((a, b) => +b.createdAt - +a.createdAt).slice(0, 12) },
    { id: "anime", title: "Anime", subtitle: "From your Anime library", items: libraryItems.anime },
    { id: "drama", title: "Drama", subtitle: null, items: cards.filter((c) => c.genres.includes("Drama")) },
    { id: "scifi", title: "Sci-Fi", subtitle: null, items: cards.filter((c) => c.genres.includes("Sci-Fi")) },
  ],
};

export const profiles: Profile[] = [
  { id: "p1", accountId: "a1", name: "rishabh", avatarPath: null, maturityRating: null, prefs: {}, createdAt: daysAgo(90), updatedAt: daysAgo(1) },
];

const queues = [
  { name: "scan", paused: false, counts: { waiting: 0, active: 1, completed: 412, failed: 0, delayed: 0 } },
  { name: "artwork", paused: false, counts: { waiting: 12, active: 2, completed: 1830, failed: 3, delayed: 0 } },
  { name: "metadata-anilist", paused: false, counts: { waiting: 4, active: 1, completed: 640, failed: 1, delayed: 2 } },
  { name: "trickplay", paused: true, counts: { waiting: 38, active: 0, completed: 220, failed: 0, delayed: 0 } },
];

export const admin = {
  summary: {
    libraries: 3,
    items: 1284,
    itemKinds: { MOVIE: 212, SERIES: 96, SEASON: 140, EPISODE: 836 },
    mediaBytes: 6.2e12,
    mediaFiles: 1048,
    artworkBytes: 1.8e9,
    artworkFiles: 3120,
    fonts: 86,
    accounts: 3,
    profiles: 4,
    activeSessions: 2,
    runningTranscodes: 1,
    needsAttention: 2,
    lastScanAt: daysAgo(0.1),
    queues,
  } satisfies AdminSummary,
  queues,
  libraries: libraries.map(
    (l, i): AdminLibrary => ({
      ...l,
      rootPath: `/media/${l.id}`,
      providerOrder: l.contentProfile === "ANIME" ? ["LOCAL", "ANILIST", "MAL"] : ["LOCAL", "TVMAZE", "WIKIPEDIA"],
      scanMode: "WATCH_AND_PERIODIC",
      writable: i === 0,
      composeAllPosters: false,
      enabled: true,
      hiddenFromHome: false,
      lastScanAt: daysAgo(0.1),
      itemCount: [612, 404, 268][i],
      storageBytes: [2.1e12, 2.9e12, 1.2e12][i],
      scanProgress: i === 1 ? { doneDirs: 41, totalDirs: 96 } : null,
      createdAt: daysAgo(90),
      updatedAt: daysAgo(1),
    }),
  ),
  accounts: [
    { id: "a1", username: "rishabh", isAdmin: true, disabled: false, createdAt: daysAgo(90), updatedAt: daysAgo(1), lastLoginAt: daysAgo(0), profileCount: 2, sessionCount: 3 },
    { id: "a2", username: "mika", isAdmin: false, disabled: false, createdAt: daysAgo(40), updatedAt: daysAgo(3), lastLoginAt: daysAgo(2), profileCount: 1, sessionCount: 1 },
    { id: "a3", username: "guest", isAdmin: false, disabled: true, createdAt: daysAgo(20), updatedAt: daysAgo(20), lastLoginAt: null, profileCount: 1, sessionCount: 0 },
  ] satisfies AdminAccount[],
  invites: [
    { id: "i1", code: "MOCHI-4821", createdBy: "rishabh", createdAt: daysAgo(2), expiresAt: daysAgo(-5), usedAt: null },
    { id: "i2", code: "TAIYAKI-0193", createdBy: "rishabh", createdAt: daysAgo(30), expiresAt: null, usedAt: daysAgo(28) },
  ] satisfies AdminInvite[],
  sessions: [
    { id: "s1", username: "rishabh", device: "web", userAgent: "Mozilla/5.0 (Macintosh) Safari/605", createdAt: daysAgo(1), expiresAt: daysAgo(-29), revokedAt: null },
    { id: "s2", username: "mika", device: "Living room TV", userAgent: "hokago-android/1.4", createdAt: daysAgo(4), expiresAt: daysAgo(-26), revokedAt: null },
  ] satisfies AdminSession[],
  settings: {
    basePath: "",
    maxConcurrentTranscodes: 3,
    maxTranscodesPerUser: 2,
    fingerprintEnabled: true,
    fingerprintThreads: 2,
    fingerprintWindow: "02:00-06:00",
    setupCompletedAt: daysAgo(90),
  } satisfies ServerSettings,
  attention: [
    {
      id: "spice-e13",
      title: "Spice and Wolf 2",
      kind: "EPISODE",
      libraryName: "Anime",
      state: "NEEDS_ATTENTION",
      confidence: 0.41,
      failures: [{ jobType: "metadata-anilist", attempts: 3, lastError: "ambiguous: episode or batch?", lastFailedAt: daysAgo(1) }],
    },
  ] satisfies AttentionItem[],
  hwaccel: {
    requested: "auto",
    method: "vaapi",
    device: "/dev/dri/renderD128",
    available: [{ method: "vaapi", device: "/dev/dri/renderD128" }],
    disabledAfterFailure: false,
    note: null,
  } satisfies AdminHwaccelStatus,
};
