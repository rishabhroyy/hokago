-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('MOVIE', 'SERIES', 'SEASON', 'EPISODE');

-- CreateEnum
CREATE TYPE "ContentProfile" AS ENUM ('GENERAL', 'ANIME');

-- CreateEnum
CREATE TYPE "Provider" AS ENUM ('LOCAL', 'EMBEDDED', 'GENERATED', 'TVMAZE', 'ANILIST', 'MAL', 'ANIDB', 'IMDB', 'WIKIDATA', 'TMDB');

-- CreateEnum
CREATE TYPE "TitleType" AS ENUM ('PRIMARY', 'ROMAJI', 'ENGLISH', 'NATIVE', 'SYNONYM');

-- CreateEnum
CREATE TYPE "CollectionKind" AS ENUM ('FRANCHISE', 'MOVIE_SET');

-- CreateEnum
CREATE TYPE "RelationType" AS ENUM ('MAIN', 'MOVIE', 'OVA', 'SPECIAL', 'RECAP', 'SIDE_STORY', 'PREQUEL', 'SEQUEL');

-- CreateEnum
CREATE TYPE "SignalType" AS ENUM ('NFO_UNIQUEID', 'EMBEDDED_TAG', 'SIBLING_CONSISTENCY', 'FOLDER_NAME', 'PROBE_RUNTIME', 'FILENAME_PARSE', 'TRACK_LANGUAGE', 'RESOLUTION_CODEC');

-- CreateEnum
CREATE TYPE "StreamType" AS ENUM ('VIDEO', 'AUDIO', 'SUBTITLE', 'ATTACHMENT', 'DATA');

-- CreateEnum
CREATE TYPE "SubtitleFormat" AS ENUM ('ASS', 'SSA', 'SRT', 'VTT', 'PGS', 'VOBSUB', 'DVBSUB');

-- CreateEnum
CREATE TYPE "ArtworkKind" AS ENUM ('POSTER', 'BACKDROP', 'STILL', 'BANNER', 'LOGO', 'THUMB');

-- CreateEnum
CREATE TYPE "ArtworkSource" AS ENUM ('LOCAL_SIDECAR', 'NFO_URL', 'EMBEDDED', 'PROVIDER', 'GENERATED');

-- CreateEnum
CREATE TYPE "SegmentType" AS ENUM ('INTRO', 'OUTRO', 'RECAP', 'PREVIEW');

-- CreateEnum
CREATE TYPE "SegmentSource" AS ENUM ('CHAPTER', 'COMMUNITY', 'FINGERPRINT', 'MANUAL');

-- CreateEnum
CREATE TYPE "LifecycleState" AS ENUM ('UNKNOWN', 'UNRELEASED', 'ONGOING', 'ENDED');

-- CreateEnum
CREATE TYPE "ItemState" AS ENUM ('OK', 'NEEDS_ATTENTION');

-- CreateEnum
CREATE TYPE "FontFormat" AS ENUM ('WOFF2', 'WOFF', 'TTF', 'OTF', 'TTC');

-- CreateEnum
CREATE TYPE "FontSource" AS ENUM ('VENDORED', 'SUBTITLE', 'THEME_BUNDLE', 'THEME_REMOTE', 'USER_DROP');

-- CreateEnum
CREATE TYPE "ThemeSource" AS ENUM ('BUILTIN', 'BUNDLE', 'IMPORTED');

-- CreateEnum
CREATE TYPE "ColorScheme" AS ENUM ('DARK', 'LIGHT');

-- CreateEnum
CREATE TYPE "FetchState" AS ENUM ('PENDING', 'OK', 'FAILED');

-- CreateEnum
CREATE TYPE "PlaybackMethod" AS ENUM ('DIRECT_PLAY', 'DIRECT_STREAM', 'TRANSCODE');

-- CreateEnum
CREATE TYPE "TranscodeState" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "PartyState" AS ENUM ('WAITING', 'PLAYING', 'PAUSED', 'ENDED');

-- CreateEnum
CREATE TYPE "ScanMode" AS ENUM ('WATCH_AND_PERIODIC', 'PERIODIC_ONLY', 'MANUAL');

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profiles" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "avatarPath" TEXT,
    "themeId" UUID,
    "maturityRating" TEXT,
    "prefs" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "device" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invites" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "createdById" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "libraries" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "rootPath" TEXT NOT NULL,
    "contentProfile" "ContentProfile" NOT NULL DEFAULT 'GENERAL',
    "mediaKinds" "MediaKind"[],
    "providerOrder" "Provider"[],
    "scanMode" "ScanMode" NOT NULL DEFAULT 'WATCH_AND_PERIODIC',
    "writable" BOOLEAN NOT NULL DEFAULT false,
    "composeAllPosters" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastScanAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "libraries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_items" (
    "id" UUID NOT NULL,
    "libraryId" UUID NOT NULL,
    "kind" "MediaKind" NOT NULL,
    "parentId" UUID,
    "title" TEXT NOT NULL,
    "sortTitle" TEXT NOT NULL,
    "originalTitle" TEXT,
    "overview" TEXT,
    "year" INTEGER,
    "runtimeMs" INTEGER,
    "seasonNumber" INTEGER,
    "episodeNumber" INTEGER,
    "absoluteNumber" INTEGER,
    "premieredAt" TIMESTAMP(3),
    "lifecycleState" "LifecycleState" NOT NULL DEFAULT 'UNKNOWN',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "state" "ItemState" NOT NULL DEFAULT 'OK',
    "extra" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "titles" (
    "id" UUID NOT NULL,
    "mediaItemId" UUID NOT NULL,
    "value" TEXT NOT NULL,
    "type" "TitleType" NOT NULL,
    "lang" TEXT,

    CONSTRAINT "titles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_files" (
    "id" UUID NOT NULL,
    "mediaItemId" UUID NOT NULL,
    "path" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "mtime" TIMESTAMP(3) NOT NULL,
    "inode" BIGINT,
    "hash" TEXT,
    "container" TEXT,
    "durationMs" INTEGER,
    "bitrate" INTEGER,
    "probedAt" TIMESTAMP(3),
    "probeFailed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_streams" (
    "id" UUID NOT NULL,
    "mediaFileId" UUID NOT NULL,
    "streamIndex" INTEGER NOT NULL,
    "type" "StreamType" NOT NULL,
    "codec" TEXT,
    "profile" TEXT,
    "lang" TEXT,
    "title" TEXT,
    "channels" INTEGER,
    "sampleRate" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "frameRate" DOUBLE PRECISION,
    "bitDepth" INTEGER,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isForced" BOOLEAN NOT NULL DEFAULT false,
    "isHearingImpaired" BOOLEAN NOT NULL DEFAULT false,
    "hdrMeta" JSONB,

    CONSTRAINT "media_streams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collections" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sortTitle" TEXT NOT NULL,
    "kind" "CollectionKind" NOT NULL DEFAULT 'FRANCHISE',
    "overview" TEXT,
    "derived" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_entries" (
    "id" UUID NOT NULL,
    "collectionId" UUID NOT NULL,
    "mediaItemId" UUID NOT NULL,
    "relationType" "RelationType" NOT NULL DEFAULT 'MAIN',
    "releaseOrder" INTEGER,
    "storyOrder" INTEGER,
    "anchor" TEXT,

    CONSTRAINT "collection_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_ids" (
    "id" UUID NOT NULL,
    "mediaItemId" UUID,
    "collectionId" UUID,
    "provider" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_ids_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "id_mappings" (
    "id" UUID NOT NULL,
    "sourceProvider" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "targetProvider" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "seasonOffset" INTEGER NOT NULL DEFAULT 0,
    "episodeOffset" INTEGER NOT NULL DEFAULT 0,
    "datasetSource" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "id_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "evidence" (
    "id" UUID NOT NULL,
    "mediaItemId" UUID NOT NULL,
    "signalType" "SignalType" NOT NULL,
    "source" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metadata_cache" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "etag" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ttlPolicy" TEXT NOT NULL,
    "lifecycleState" "LifecycleState" NOT NULL DEFAULT 'UNKNOWN',
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "metadata_cache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artwork" (
    "id" UUID NOT NULL,
    "mediaItemId" UUID,
    "collectionId" UUID,
    "kind" "ArtworkKind" NOT NULL,
    "source" "ArtworkSource" NOT NULL,
    "priority" INTEGER NOT NULL,
    "bytesPath" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "sizeBytes" INTEGER,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artwork_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subtitle_tracks" (
    "id" UUID NOT NULL,
    "mediaFileId" UUID NOT NULL,
    "lang" TEXT,
    "title" TEXT,
    "format" "SubtitleFormat" NOT NULL,
    "forced" BOOLEAN NOT NULL DEFAULT false,
    "sdh" BOOLEAN NOT NULL DEFAULT false,
    "streamIndex" INTEGER,
    "path" TEXT,
    "requiresBurnIn" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subtitle_tracks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fonts" (
    "hash" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "subfamily" TEXT,
    "weight" INTEGER,
    "style" TEXT,
    "format" "FontFormat" NOT NULL,
    "source" "FontSource" NOT NULL,
    "path" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "unicodeRange" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fonts_pkey" PRIMARY KEY ("hash")
);

-- CreateTable
CREATE TABLE "media_file_fonts" (
    "mediaFileId" UUID NOT NULL,
    "fontHash" TEXT NOT NULL,

    CONSTRAINT "media_file_fonts_pkey" PRIMARY KEY ("mediaFileId","fontHash")
);

-- CreateTable
CREATE TABLE "themes" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" "ThemeSource" NOT NULL DEFAULT 'BUILTIN',
    "colorScheme" "ColorScheme" NOT NULL DEFAULT 'DARK',
    "tokens" JSONB NOT NULL,
    "bundlePath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "themes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "theme_fonts" (
    "themeId" UUID NOT NULL,
    "fontHash" TEXT NOT NULL,

    CONSTRAINT "theme_fonts_pkey" PRIMARY KEY ("themeId","fontHash")
);

-- CreateTable
CREATE TABLE "theme_font_fetches" (
    "id" UUID NOT NULL,
    "themeId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "state" "FetchState" NOT NULL DEFAULT 'PENDING',
    "fontHash" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "theme_font_fetches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "playback_state" (
    "id" UUID NOT NULL,
    "profileId" UUID NOT NULL,
    "mediaItemId" UUID NOT NULL,
    "positionMs" INTEGER NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "watched" BOOLEAN NOT NULL DEFAULT false,
    "playCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "playback_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_segments" (
    "id" UUID NOT NULL,
    "mediaItemId" UUID NOT NULL,
    "type" "SegmentType" NOT NULL,
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER NOT NULL,
    "source" "SegmentSource" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "playback_sessions" (
    "id" UUID NOT NULL,
    "profileId" UUID NOT NULL,
    "mediaItemId" UUID NOT NULL,
    "mediaFileId" UUID NOT NULL,
    "method" "PlaybackMethod" NOT NULL,
    "deviceProfile" JSONB NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "lastHeartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "positionMs" INTEGER NOT NULL DEFAULT 0,
    "bandwidthKbps" INTEGER,

    CONSTRAINT "playback_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trickplay" (
    "id" UUID NOT NULL,
    "mediaFileId" UUID NOT NULL,
    "tileWidth" INTEGER NOT NULL,
    "tileHeight" INTEGER NOT NULL,
    "intervalMs" INTEGER NOT NULL DEFAULT 10000,
    "tilesPerSheet" INTEGER NOT NULL,
    "sheetPaths" TEXT[],
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trickplay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcode_jobs" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "mediaFileId" UUID NOT NULL,
    "method" "PlaybackMethod" NOT NULL,
    "deviceProfile" JSONB NOT NULL,
    "state" "TranscodeState" NOT NULL DEFAULT 'QUEUED',
    "segmentFrom" INTEGER,
    "segmentTo" INTEGER,
    "pid" INTEGER,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transcode_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "watch_parties" (
    "id" UUID NOT NULL,
    "hostProfileId" UUID NOT NULL,
    "mediaItemId" UUID NOT NULL,
    "state" "PartyState" NOT NULL DEFAULT 'WAITING',
    "positionMs" INTEGER NOT NULL DEFAULT 0,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inviteCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "watch_parties_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "party_members" (
    "partyId" UUID NOT NULL,
    "profileId" UUID NOT NULL,
    "sessionId" UUID,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ready" BOOLEAN NOT NULL DEFAULT false,
    "positionMs" INTEGER NOT NULL DEFAULT 0,
    "reportedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "party_members_pkey" PRIMARY KEY ("partyId","profileId")
);

-- CreateTable
CREATE TABLE "server_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "basePath" TEXT NOT NULL DEFAULT '/',
    "maxConcurrentTranscodes" INTEGER NOT NULL DEFAULT 2,
    "maxTranscodesPerUser" INTEGER NOT NULL DEFAULT 1,
    "fingerprintEnabled" BOOLEAN NOT NULL DEFAULT false,
    "fingerprintThreads" INTEGER NOT NULL DEFAULT 2,
    "fingerprintWindow" TEXT,
    "setupCompletedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "server_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_config" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "secretEnc" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounts_username_key" ON "accounts"("username");

-- CreateIndex
CREATE INDEX "profiles_accountId_idx" ON "profiles"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "profiles_accountId_name_key" ON "profiles"("accountId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refreshTokenHash_key" ON "sessions"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "sessions_accountId_idx" ON "sessions"("accountId");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "invites_code_key" ON "invites"("code");

-- CreateIndex
CREATE UNIQUE INDEX "libraries_rootPath_key" ON "libraries"("rootPath");

-- CreateIndex
CREATE INDEX "media_items_libraryId_kind_idx" ON "media_items"("libraryId", "kind");

-- CreateIndex
CREATE INDEX "media_items_parentId_idx" ON "media_items"("parentId");

-- CreateIndex
CREATE INDEX "media_items_sortTitle_idx" ON "media_items"("sortTitle");

-- CreateIndex
CREATE INDEX "media_items_kind_confidence_idx" ON "media_items"("kind", "confidence");

-- CreateIndex
CREATE INDEX "media_items_state_idx" ON "media_items"("state");

-- CreateIndex
CREATE INDEX "media_items_parentId_seasonNumber_episodeNumber_idx" ON "media_items"("parentId", "seasonNumber", "episodeNumber");

-- CreateIndex
CREATE INDEX "titles_mediaItemId_idx" ON "titles"("mediaItemId");

-- CreateIndex
CREATE INDEX "titles_value_idx" ON "titles"("value");

-- CreateIndex
CREATE UNIQUE INDEX "media_files_path_key" ON "media_files"("path");

-- CreateIndex
CREATE INDEX "media_files_mediaItemId_idx" ON "media_files"("mediaItemId");

-- CreateIndex
CREATE INDEX "media_files_hash_idx" ON "media_files"("hash");

-- CreateIndex
CREATE INDEX "media_files_inode_idx" ON "media_files"("inode");

-- CreateIndex
CREATE INDEX "media_streams_mediaFileId_type_idx" ON "media_streams"("mediaFileId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "media_streams_mediaFileId_streamIndex_key" ON "media_streams"("mediaFileId", "streamIndex");

-- CreateIndex
CREATE INDEX "collections_sortTitle_idx" ON "collections"("sortTitle");

-- CreateIndex
CREATE INDEX "collection_entries_collectionId_releaseOrder_idx" ON "collection_entries"("collectionId", "releaseOrder");

-- CreateIndex
CREATE INDEX "collection_entries_collectionId_storyOrder_idx" ON "collection_entries"("collectionId", "storyOrder");

-- CreateIndex
CREATE INDEX "collection_entries_mediaItemId_idx" ON "collection_entries"("mediaItemId");

-- CreateIndex
CREATE UNIQUE INDEX "collection_entries_collectionId_mediaItemId_key" ON "collection_entries"("collectionId", "mediaItemId");

-- CreateIndex
CREATE INDEX "external_ids_provider_providerId_idx" ON "external_ids"("provider", "providerId");

-- CreateIndex
CREATE UNIQUE INDEX "external_ids_mediaItemId_provider_key" ON "external_ids"("mediaItemId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "external_ids_collectionId_provider_key" ON "external_ids"("collectionId", "provider");

-- CreateIndex
CREATE INDEX "id_mappings_sourceProvider_sourceId_idx" ON "id_mappings"("sourceProvider", "sourceId");

-- CreateIndex
CREATE INDEX "id_mappings_targetProvider_targetId_idx" ON "id_mappings"("targetProvider", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "id_mappings_sourceProvider_sourceId_targetProvider_targetId_key" ON "id_mappings"("sourceProvider", "sourceId", "targetProvider", "targetId");

-- CreateIndex
CREATE INDEX "evidence_mediaItemId_idx" ON "evidence"("mediaItemId");

-- CreateIndex
CREATE INDEX "evidence_mediaItemId_signalType_idx" ON "evidence"("mediaItemId", "signalType");

-- CreateIndex
CREATE INDEX "metadata_cache_expiresAt_idx" ON "metadata_cache"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "metadata_cache_provider_externalId_key" ON "metadata_cache"("provider", "externalId");

-- CreateIndex
CREATE INDEX "artwork_mediaItemId_kind_priority_idx" ON "artwork"("mediaItemId", "kind", "priority");

-- CreateIndex
CREATE INDEX "artwork_collectionId_kind_priority_idx" ON "artwork"("collectionId", "kind", "priority");

-- CreateIndex
CREATE INDEX "artwork_hash_idx" ON "artwork"("hash");

-- CreateIndex
CREATE UNIQUE INDEX "artwork_mediaItemId_kind_source_key" ON "artwork"("mediaItemId", "kind", "source");

-- CreateIndex
CREATE UNIQUE INDEX "artwork_collectionId_kind_source_key" ON "artwork"("collectionId", "kind", "source");

-- CreateIndex
CREATE INDEX "subtitle_tracks_mediaFileId_idx" ON "subtitle_tracks"("mediaFileId");

-- CreateIndex
CREATE INDEX "fonts_family_idx" ON "fonts"("family");

-- CreateIndex
CREATE INDEX "fonts_source_idx" ON "fonts"("source");

-- CreateIndex
CREATE INDEX "media_file_fonts_fontHash_idx" ON "media_file_fonts"("fontHash");

-- CreateIndex
CREATE UNIQUE INDEX "themes_slug_key" ON "themes"("slug");

-- CreateIndex
CREATE INDEX "theme_fonts_fontHash_idx" ON "theme_fonts"("fontHash");

-- CreateIndex
CREATE INDEX "theme_font_fetches_state_idx" ON "theme_font_fetches"("state");

-- CreateIndex
CREATE UNIQUE INDEX "theme_font_fetches_themeId_url_key" ON "theme_font_fetches"("themeId", "url");

-- CreateIndex
CREATE INDEX "playback_state_profileId_updatedAt_idx" ON "playback_state"("profileId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "playback_state_profileId_mediaItemId_key" ON "playback_state"("profileId", "mediaItemId");

-- CreateIndex
CREATE INDEX "media_segments_mediaItemId_idx" ON "media_segments"("mediaItemId");

-- CreateIndex
CREATE UNIQUE INDEX "media_segments_mediaItemId_type_source_key" ON "media_segments"("mediaItemId", "type", "source");

-- CreateIndex
CREATE INDEX "playback_sessions_profileId_endedAt_idx" ON "playback_sessions"("profileId", "endedAt");

-- CreateIndex
CREATE INDEX "playback_sessions_mediaItemId_idx" ON "playback_sessions"("mediaItemId");

-- CreateIndex
CREATE UNIQUE INDEX "trickplay_mediaFileId_key" ON "trickplay"("mediaFileId");

-- CreateIndex
CREATE INDEX "transcode_jobs_sessionId_idx" ON "transcode_jobs"("sessionId");

-- CreateIndex
CREATE INDEX "transcode_jobs_state_idx" ON "transcode_jobs"("state");

-- CreateIndex
CREATE UNIQUE INDEX "watch_parties_inviteCode_key" ON "watch_parties"("inviteCode");

-- CreateIndex
CREATE INDEX "watch_parties_state_idx" ON "watch_parties"("state");

-- CreateIndex
CREATE UNIQUE INDEX "party_members_sessionId_key" ON "party_members"("sessionId");

-- CreateIndex
CREATE INDEX "party_members_profileId_idx" ON "party_members"("profileId");

-- CreateIndex
CREATE UNIQUE INDEX "provider_config_provider_key" ON "provider_config"("provider");

-- AddForeignKey
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_themeId_fkey" FOREIGN KEY ("themeId") REFERENCES "themes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_libraryId_fkey" FOREIGN KEY ("libraryId") REFERENCES "libraries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_items" ADD CONSTRAINT "media_items_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "titles" ADD CONSTRAINT "titles_mediaItemId_fkey" FOREIGN KEY ("mediaItemId") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_files" ADD CONSTRAINT "media_files_mediaItemId_fkey" FOREIGN KEY ("mediaItemId") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_streams" ADD CONSTRAINT "media_streams_mediaFileId_fkey" FOREIGN KEY ("mediaFileId") REFERENCES "media_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_entries" ADD CONSTRAINT "collection_entries_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_entries" ADD CONSTRAINT "collection_entries_mediaItemId_fkey" FOREIGN KEY ("mediaItemId") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_ids" ADD CONSTRAINT "external_ids_mediaItemId_fkey" FOREIGN KEY ("mediaItemId") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_ids" ADD CONSTRAINT "external_ids_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_mediaItemId_fkey" FOREIGN KEY ("mediaItemId") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artwork" ADD CONSTRAINT "artwork_mediaItemId_fkey" FOREIGN KEY ("mediaItemId") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artwork" ADD CONSTRAINT "artwork_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subtitle_tracks" ADD CONSTRAINT "subtitle_tracks_mediaFileId_fkey" FOREIGN KEY ("mediaFileId") REFERENCES "media_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_file_fonts" ADD CONSTRAINT "media_file_fonts_mediaFileId_fkey" FOREIGN KEY ("mediaFileId") REFERENCES "media_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_file_fonts" ADD CONSTRAINT "media_file_fonts_fontHash_fkey" FOREIGN KEY ("fontHash") REFERENCES "fonts"("hash") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "theme_fonts" ADD CONSTRAINT "theme_fonts_themeId_fkey" FOREIGN KEY ("themeId") REFERENCES "themes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "theme_fonts" ADD CONSTRAINT "theme_fonts_fontHash_fkey" FOREIGN KEY ("fontHash") REFERENCES "fonts"("hash") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "theme_font_fetches" ADD CONSTRAINT "theme_font_fetches_themeId_fkey" FOREIGN KEY ("themeId") REFERENCES "themes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playback_state" ADD CONSTRAINT "playback_state_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playback_state" ADD CONSTRAINT "playback_state_mediaItemId_fkey" FOREIGN KEY ("mediaItemId") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_segments" ADD CONSTRAINT "media_segments_mediaItemId_fkey" FOREIGN KEY ("mediaItemId") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playback_sessions" ADD CONSTRAINT "playback_sessions_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playback_sessions" ADD CONSTRAINT "playback_sessions_mediaItemId_fkey" FOREIGN KEY ("mediaItemId") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playback_sessions" ADD CONSTRAINT "playback_sessions_mediaFileId_fkey" FOREIGN KEY ("mediaFileId") REFERENCES "media_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trickplay" ADD CONSTRAINT "trickplay_mediaFileId_fkey" FOREIGN KEY ("mediaFileId") REFERENCES "media_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcode_jobs" ADD CONSTRAINT "transcode_jobs_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "playback_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcode_jobs" ADD CONSTRAINT "transcode_jobs_mediaFileId_fkey" FOREIGN KEY ("mediaFileId") REFERENCES "media_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watch_parties" ADD CONSTRAINT "watch_parties_hostProfileId_fkey" FOREIGN KEY ("hostProfileId") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watch_parties" ADD CONSTRAINT "watch_parties_mediaItemId_fkey" FOREIGN KEY ("mediaItemId") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_members" ADD CONSTRAINT "party_members_partyId_fkey" FOREIGN KEY ("partyId") REFERENCES "watch_parties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_members" ADD CONSTRAINT "party_members_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "party_members" ADD CONSTRAINT "party_members_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "playback_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
