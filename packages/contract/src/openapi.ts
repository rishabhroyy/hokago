import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import type { OpenAPIObject } from "openapi3-ts/oas30";
import { z } from "zod";
import { HealthResponse } from "./health.js";

extendZodWithOpenApi(z);
import {
  LibrarySummary,
  MediaCard,
  MediaItemDetail,
  LibraryItemsParams,
  MediaItemDetailParams,
  MediaItemDetailQuery,
  NotFoundError as BrowseNotFoundError,
} from "./browse.js";
import {
  Profile,
  ProfileParams,
  CreateProfileBody,
  UpdateProfileBody,
  NotFoundError as ProfileNotFoundError,
} from "./profiles.js";
import {
  RegisterBody,
  RegisterResponse,
  LoginBody,
  LoginResponse,
  RefreshBody,
  RefreshResponse,
  RevokedResponse,
  ChangePasswordBody,
  ChangePasswordResponse,
  SessionSummary,
  SessionParams,
  DeviceSummary,
  DeviceParams,
  PairingRequestBody,
  PairingRequestResponse,
  PairingVerifyBody,
  PairingVerifyResponse,
  PairingStatusBody,
  PairingStatusResponse,
  CreateInviteBody,
  InviteResponse,
  ErrorResponse as AuthErrorResponse,
} from "./auth.js";
import {
  MediaItemFilesParams,
  MediaItemFilesResponse,
} from "./browse.js";
import {
  DownloadCreateBody,
  DownloadInfo,
  DownloadListQuery,
  DownloadParams,
  DownloadSubtitleParams,
  DownloadFontParams,
  DownloadArtifactManifest,
  ErrorResponse as DownloadErrorResponse,
} from "./downloads.js";
import {
  StartPlaybackBody,
  StartPlaybackResponse,
  PlaybackSessionParams,
  SeekBody,
  SeekResponse,
  AudioTrackSwitchBody,
  AudioTrackSwitchResponse,
  QualitySwitchBody,
  QualitySwitchResponse,
  HeartbeatBody,
  HeartbeatResponse,
  StopResponse,
  ContinueWatchingQuery,
  ContinueWatchingResponse,
  WatchHistoryQuery,
  WatchHistoryResponse,
  SetWatchedParams,
  SetWatchedBody,
  SetWatchedResponse,
  WatchStateSyncBody,
  WatchStateSyncResponse,
  ErrorResponse as PlaybackErrorResponse,
} from "./playback.js";
import {
  QueueListResponse,
  QueueParams,
  QueueJobsQuery,
  QueueJobsResponse,
  QueuePausedResponse,
  QueueRetriedResponse,
  QueueCleanBody,
  QueueCleanResponse,
  AdminSummary,
  AdminLibrary,
  AdminLibraryParams,
  AdminLibraryCreateBody,
  AdminLibraryUpdateBody,
  AdminScanResponse,
  AdminAccount,
  AdminAccountParams,
  AdminAccountCreateBody,
  AdminAccountUpdateBody,
  AdminAccountResponse,
  AdminDeletedResponse,
  AdminInvite,
  AdminInviteParams,
  AdminSession,
  ServerSettings,
  ServerSettingsUpdateBody,
  AttentionItem,
  AdminHwaccelStatus,
  ErrorResponse as AdminErrorResponse,
} from "./admin.js";
import {
  MediaFileParams,
  MediaFileFontsResponse,
  MediaFileTracksResponse,
  MediaFileTrickplayResponse,
  ErrorResponse as MediaFileErrorResponse,
} from "./media-files.js";
import { HomeQuery, HomeResponse } from "./home.js";
import {
  WatchPartyResponse,
  CreatePartyBody,
  JoinPartyBody,
  PartyParams,
  ControlPartyBody,
  ReadyPartyBody,
  LinkSessionBody,
  PartyOkResponse,
  ErrorResponse as PartyErrorResponse,
} from "./watch-party.js";

const json = (schema: z.ZodTypeAny) => ({ content: { "application/json": { schema } } });

// Binary/byte routes (media files, fonts, subtitles, segments, playlists)
// return raw bytes, not JSON. They're registered so generated clients know
// the paths exist and are typed as strings — openapi-fetch still returns a
// Response for them either way.
const binary = (mime: string) => ({ content: { [mime]: { schema: { type: "string" as const, format: "binary" as const } } } });

export function buildOpenApiDocument(): OpenAPIObject {
  const registry = new OpenAPIRegistry();

  registry.registerPath({
    method: "get",
    path: "/health",
    summary: "Health check",
    responses: { 200: { description: "Service is healthy", ...json(HealthResponse) } },
  });

 // Browse (/)
  registry.registerPath({
    method: "get",
    path: "/libraries",
    summary: "List enabled libraries",
    responses: { 200: { description: "OK", ...json(z.array(LibrarySummary)) } },
  });
  registry.registerPath({
    method: "get",
    path: "/libraries/{id}/items",
    summary: "Top-level items in a library",
    request: { params: LibraryItemsParams },
    responses: { 200: { description: "OK", ...json(z.array(MediaCard)) } },
  });
  registry.registerPath({
    method: "get",
    path: "/media-items/{id}",
    summary: "Media item detail",
    request: { params: MediaItemDetailParams, query: MediaItemDetailQuery },
    responses: {
      200: { description: "OK", ...json(MediaItemDetail) },
      404: { description: "Not found", ...json(BrowseNotFoundError) },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/media-items/{id}/files",
    summary: "All playable files of a media item (downloads/version picker; browse only exposes the first)",
    request: { params: MediaItemFilesParams },
    responses: {
      200: { description: "OK", ...json(MediaItemFilesResponse) },
      404: { description: "Not found", ...json(BrowseNotFoundError) },
    },
  });

 // Profiles
  registry.registerPath({
    method: "get",
    path: "/profiles",
    summary: "List profiles for the authenticated account",
    responses: { 200: { description: "OK", ...json(z.array(Profile)) } },
  });
  registry.registerPath({
    method: "get",
    path: "/profiles/{id}",
    summary: "Get a profile",
    request: { params: ProfileParams },
    responses: {
      200: { description: "OK", ...json(Profile) },
      404: { description: "Not found", ...json(ProfileNotFoundError) },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/profiles",
    summary: "Create a profile",
    request: { body: json(CreateProfileBody) },
    responses: { 201: { description: "Created", ...json(Profile) } },
  });
  registry.registerPath({
    method: "patch",
    path: "/profiles/{id}",
    summary: "Update a profile",
    request: { params: ProfileParams, body: json(UpdateProfileBody) },
    responses: {
      200: { description: "OK", ...json(Profile) },
      404: { description: "Not found", ...json(ProfileNotFoundError) },
    },
  });
  registry.registerPath({
    method: "delete",
    path: "/profiles/{id}",
    summary: "Delete a profile",
    request: { params: ProfileParams },
    responses: {
      204: { description: "Deleted" },
      404: { description: "Not found", ...json(ProfileNotFoundError) },
    },
  });

 // Auth
  registry.registerPath({
    method: "post",
    path: "/auth/register",
    summary: "Register an account via invite code",
    request: { body: json(RegisterBody) },
    responses: {
      201: { description: "Created", ...json(RegisterResponse) },
      400: { description: "Invalid or expired invite", ...json(AuthErrorResponse) },
      409: { description: "Username taken", ...json(AuthErrorResponse) },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/auth/login",
    summary: "Log in",
    request: { body: json(LoginBody) },
    responses: {
      200: { description: "OK", ...json(LoginResponse) },
      401: { description: "Invalid credentials", ...json(AuthErrorResponse) },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/auth/refresh",
    summary: "Exchange a refresh token for a new access token",
    request: { body: json(RefreshBody) },
    responses: {
      200: { description: "OK", ...json(RefreshResponse) },
      401: { description: "Invalid or revoked refresh token", ...json(AuthErrorResponse) },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/auth/logout",
    summary: "Revoke a refresh token",
    request: { body: json(RefreshBody) },
    responses: {
      200: { description: "OK", ...json(RevokedResponse) },
      404: { description: "Session not found", ...json(AuthErrorResponse) },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/auth/password",
    summary: "Change the authenticated account's password",
    request: { body: json(ChangePasswordBody) },
    responses: {
      200: { description: "OK", ...json(ChangePasswordResponse) },
      401: { description: "Current password incorrect", ...json(AuthErrorResponse) },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/auth/sessions",
    summary: "List sessions for the authenticated account",
    responses: { 200: { description: "OK", ...json(z.array(SessionSummary)) } },
  });
  registry.registerPath({
    method: "post",
    path: "/auth/sessions/{id}/revoke",
    summary: "Revoke a session",
    request: { params: SessionParams },
    responses: {
      200: { description: "OK", ...json(RevokedResponse) },
      404: { description: "Session not found", ...json(AuthErrorResponse) },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/auth/invites",
    summary: "Create an invite code (admin only)",
    request: { body: json(CreateInviteBody.optional()) },
    responses: { 200: { description: "OK", ...json(InviteResponse) } },
  });
  registry.registerPath({
    method: "get",
    path: "/auth/devices",
    summary: "List registered devices for the authenticated account",
    responses: { 200: { description: "OK", ...json(z.array(DeviceSummary)) } },
  });
  registry.registerPath({
    method: "delete",
    path: "/auth/devices/{id}",
    summary: "Remove a device — revokes every session bound to it",
    request: { params: DeviceParams },
    responses: {
      200: { description: "OK", ...json(RevokedResponse) },
      404: { description: "Device not found", ...json(AuthErrorResponse) },
    },
  });

  // TV-style pairing — TVs can't type passwords.
  registry.registerPath({
    method: "post",
    path: "/auth/pair/request",
    summary: "Request a pairing code to display (unauthenticated — the TV)",
    request: { body: json(PairingRequestBody) },
    responses: {
      200: { description: "OK — code to show on screen", ...json(PairingRequestResponse) },
      429: { description: "Rate limited", ...json(AuthErrorResponse) },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/auth/pair/verify",
    summary: "Approve a pairing code (authenticated — the phone/PC)",
    request: { body: json(PairingVerifyBody) },
    responses: {
      200: { description: "OK — code approved", ...json(PairingVerifyResponse) },
      404: { description: "Invalid or expired code", ...json(AuthErrorResponse) },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/auth/pair/status",
    summary: "Poll pairing status; mints the session once approved (unauthenticated — the TV)",
    request: { body: json(PairingStatusBody) },
    responses: {
      200: { description: "OK — status, plus tokens when just approved", ...json(PairingStatusResponse) },
      404: { description: "Unknown pairing", ...json(AuthErrorResponse) },
    },
  });

  registry.registerPath({
    method: "get",
    path: "/home",
    summary: "Front-page discovery: hero slides + rails, personalized to the instance and profile",
    request: { query: HomeQuery },
    responses: { 200: { description: "OK", ...json(HomeResponse) } },
  });

  // Playback (//)
  registry.registerPath({
    method: "post",
    path: "/playback/start",
    summary: "Start a playback session",
    request: { body: json(StartPlaybackBody) },
    responses: {
      200: { description: "OK", ...json(StartPlaybackResponse) },
      404: { description: "Media file not found", ...json(PlaybackErrorResponse) },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/playback/{sessionId}/seek",
    summary: "Seek within a transcoding session",
    request: { params: PlaybackSessionParams, body: json(SeekBody) },
    responses: {
      200: { description: "OK", ...json(SeekResponse) },
      404: { description: "No active session", ...json(PlaybackErrorResponse) },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/playback/{sessionId}/audio-track",
    summary: "Switch the audio track of a transcoding session",
    request: { params: PlaybackSessionParams, body: json(AudioTrackSwitchBody) },
    responses: {
      200: { description: "OK", ...json(AudioTrackSwitchResponse) },
      404: { description: "No active session", ...json(PlaybackErrorResponse) },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/playback/{sessionId}/quality",
    summary: "Switch the encode quality of a transcoding session (may change REMUX to TRANSCODE)",
    request: { params: PlaybackSessionParams, body: json(QualitySwitchBody) },
    responses: {
      200: { description: "OK", ...json(QualitySwitchResponse) },
      404: { description: "No active session", ...json(PlaybackErrorResponse) },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/playback/{sessionId}/heartbeat",
    summary: "Report playback position",
    request: { params: PlaybackSessionParams, body: json(HeartbeatBody) },
    responses: {
      200: { description: "OK", ...json(HeartbeatResponse) },
      404: { description: "Session not found", ...json(PlaybackErrorResponse) },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/playback/{sessionId}/stop",
    summary: "End a playback session",
    request: { params: PlaybackSessionParams },
    responses: {
      200: { description: "OK", ...json(StopResponse) },
      404: { description: "Session not found", ...json(PlaybackErrorResponse) },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/continue-watching",
    summary: "Continue-watching rail for a profile",
    request: { query: ContinueWatchingQuery },
    responses: { 200: { description: "OK", ...json(ContinueWatchingResponse) } },
  });
  registry.registerPath({
    method: "get",
    path: "/watch-history",
    summary: "Day-by-day watch history for a profile + media item",
    request: { query: WatchHistoryQuery },
    responses: { 200: { description: "OK", ...json(WatchHistoryResponse) } },
  });
  registry.registerPath({
    method: "post",
    path: "/watch-state/{mediaItemId}",
    summary: "Manually mark a media item watched or unwatched (right-click menu)",
    request: { params: SetWatchedParams, body: json(SetWatchedBody) },
    responses: {
      200: { description: "OK", ...json(SetWatchedResponse) },
      404: { description: "Media item not found", ...json(PlaybackErrorResponse) },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/watch-state/sync",
    summary: "Bulk-upsert per-profile playback state — native clients replay offline progress on reconnect",
    request: { body: json(WatchStateSyncBody) },
    responses: {
      200: { description: "OK", ...json(WatchStateSyncResponse) },
      404: { description: "Profile not found", ...json(PlaybackErrorResponse) },
    },
  });

 // Watch parties
  registry.registerPath({
    method: "post",
    path: "/parties",
    summary: "Create a watch party for a media item (creator is host)",
    request: { body: json(CreatePartyBody) },
    responses: {
      201: { description: "Created", ...json(WatchPartyResponse) },
      404: { description: "Media item or profile not found", ...json(PartyErrorResponse) },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/parties/{partyId}",
    summary: "Watch party state (host or member only)",
    request: { params: PartyParams },
    responses: {
      200: { description: "OK", ...json(WatchPartyResponse) },
      404: { description: "Party not found", ...json(PartyErrorResponse) },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/parties/join",
    summary: "Join a watch party by invite code",
    request: { body: json(JoinPartyBody) },
    responses: {
      200: { description: "OK — party state", ...json(WatchPartyResponse) },
      404: { description: "Party or profile not found", ...json(PartyErrorResponse) },
      409: { description: "Party ended — cannot join", ...json(PartyErrorResponse) },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/parties/{partyId}/leave",
    summary: "Leave a watch party (host leaving ends the party)",
    request: { params: PartyParams },
    responses: {
      200: { description: "OK", ...json(PartyOkResponse) },
      404: { description: "Party not found", ...json(PartyErrorResponse) },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/parties/{partyId}/control",
    summary: "Host command: set party state and media position (timekeeper)",
    request: { params: PartyParams, body: json(ControlPartyBody) },
    responses: {
      200: { description: "OK — updated party state", ...json(WatchPartyResponse) },
      403: { description: "Host only", ...json(PartyErrorResponse) },
      404: { description: "Party not found", ...json(PartyErrorResponse) },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/parties/{partyId}/ready",
    summary: "Toggle a member's ready flag (waiting room signalling)",
    request: { params: PartyParams, body: json(ReadyPartyBody) },
    responses: {
      200: { description: "OK — updated party state", ...json(WatchPartyResponse) },
      404: { description: "Party not found", ...json(PartyErrorResponse) },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/parties/{partyId}/session",
    summary: "Link a playback session to the member's party membership",
    request: { params: PartyParams, body: json(LinkSessionBody) },
    responses: {
      200: { description: "OK — updated party state", ...json(WatchPartyResponse) },
      404: { description: "Party or session not found", ...json(PartyErrorResponse) },
    },
  });

 // Admin
  registry.registerPath({
    method: "get",
    path: "/admin/queues",
    summary: "List queue states",
    responses: { 200: { description: "OK", ...json(QueueListResponse) } },
  });
  registry.registerPath({
    method: "get",
    path: "/admin/queues/{name}/jobs",
    summary: "List jobs in a queue",
    request: { params: QueueParams, query: QueueJobsQuery },
    responses: {
      200: { description: "OK", ...json(QueueJobsResponse) },
      404: { description: "Unknown queue", ...json(AdminErrorResponse) },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/admin/queues/{name}/pause",
    summary: "Pause a queue",
    request: { params: QueueParams },
    responses: {
      200: { description: "OK", ...json(QueuePausedResponse) },
      404: { description: "Unknown queue", ...json(AdminErrorResponse) },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/admin/queues/{name}/resume",
    summary: "Resume a queue",
    request: { params: QueueParams },
    responses: {
      200: { description: "OK", ...json(QueuePausedResponse) },
      404: { description: "Unknown queue", ...json(AdminErrorResponse) },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/admin/queues/{name}/retry-failed",
    summary: "Retry all failed jobs in a queue",
    request: { params: QueueParams },
    responses: {
      200: { description: "OK", ...json(QueueRetriedResponse) },
      404: { description: "Unknown queue", ...json(AdminErrorResponse) },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/admin/queues/{name}/clean",
    summary: "Clean jobs in a given state from a queue",
    request: { params: QueueParams, body: json(QueueCleanBody.optional()) },
    responses: {
      200: { description: "OK", ...json(QueueCleanResponse) },
      404: { description: "Unknown queue", ...json(AdminErrorResponse) },
    },
  });

 // Admin management (/admin-api)
  registry.registerPath({
    method: "get",
    path: "/admin-api/summary",
    summary: "Dashboard summary: counts, bytes, queue states, attention",
    responses: { 200: { description: "OK", ...json(AdminSummary) } },
  });
  registry.registerPath({
    method: "get",
    path: "/admin-api/libraries",
    summary: "List all libraries",
    responses: { 200: { description: "OK", ...json(z.array(AdminLibrary)) } },
  });
  registry.registerPath({
    method: "post",
    path: "/admin-api/libraries",
    summary: "Create a library",
    request: { body: json(AdminLibraryCreateBody) },
    responses: {
      201: { description: "Created", ...json(AdminLibrary) },
      409: { description: "rootPath already in use", ...json(AdminErrorResponse) },
    },
  });
  registry.registerPath({
    method: "patch",
    path: "/admin-api/libraries/{id}",
    summary: "Update a library",
    request: { params: AdminLibraryParams, body: json(AdminLibraryUpdateBody) },
    responses: {
      200: { description: "OK", ...json(AdminLibrary) },
      404: { description: "Not found", ...json(AdminErrorResponse) },
    },
  });
  registry.registerPath({
    method: "delete",
    path: "/admin-api/libraries/{id}",
    summary: "Delete a library and everything under it",
    request: { params: AdminLibraryParams },
    responses: {
      200: { description: "OK", ...json(AdminDeletedResponse) },
      404: { description: "Not found", ...json(AdminErrorResponse) },
    },
  });
  registry.registerPath({
    method: "post",
    path: "/admin-api/libraries/{id}/scan",
    summary: "Enqueue a scan for a library",
    request: { params: AdminLibraryParams },
    responses: {
      200: { description: "OK", ...json(AdminScanResponse) },
      404: { description: "Not found", ...json(AdminErrorResponse) },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/admin-api/accounts",
    summary: "List all accounts",
    responses: { 200: { description: "OK", ...json(z.array(AdminAccount)) } },
  });
  registry.registerPath({
    method: "post",
    path: "/admin-api/accounts",
    summary: "Create an account",
    request: { body: json(AdminAccountCreateBody) },
    responses: {
      201: { description: "Created", ...json(AdminAccountResponse) },
      409: { description: "Username taken", ...json(AdminErrorResponse) },
    },
  });
  registry.registerPath({
    method: "patch",
    path: "/admin-api/accounts/{id}",
    summary: "Update an account",
    request: { params: AdminAccountParams, body: json(AdminAccountUpdateBody) },
    responses: {
      200: { description: "OK", ...json(AdminAccountResponse) },
      400: { description: "Self-lockout attempt", ...json(AdminErrorResponse) },
      404: { description: "Not found", ...json(AdminErrorResponse) },
    },
  });
  registry.registerPath({
    method: "delete",
    path: "/admin-api/accounts/{id}",
    summary: "Delete an account",
    request: { params: AdminAccountParams },
    responses: {
      200: { description: "OK", ...json(AdminDeletedResponse) },
      400: { description: "Cannot delete self", ...json(AdminErrorResponse) },
      404: { description: "Not found", ...json(AdminErrorResponse) },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/admin-api/invites",
    summary: "List invite codes",
    responses: { 200: { description: "OK", ...json(z.array(AdminInvite)) } },
  });
  registry.registerPath({
    method: "post",
    path: "/admin-api/invites",
    summary: "Create an invite code",
    request: { body: json(CreateInviteBody.optional()) },
    responses: { 200: { description: "OK", ...json(InviteResponse) } },
  });
  registry.registerPath({
    method: "delete",
    path: "/admin-api/invites/{id}",
    summary: "Revoke an invite code",
    request: { params: AdminInviteParams },
    responses: {
      200: { description: "OK", ...json(AdminDeletedResponse) },
      404: { description: "Not found", ...json(AdminErrorResponse) },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/admin-api/sessions",
    summary: "List all sessions",
    responses: { 200: { description: "OK", ...json(z.array(AdminSession)) } },
  });
  registry.registerPath({
    method: "post",
    path: "/admin-api/sessions/{id}/revoke",
    summary: "Revoke a session",
    request: { params: AdminInviteParams },
    responses: {
      200: { description: "OK", ...json(RevokedResponse) },
      404: { description: "Not found", ...json(AdminErrorResponse) },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/admin-api/settings",
    summary: "Get server settings",
    responses: { 200: { description: "OK", ...json(ServerSettings) } },
  });
  registry.registerPath({
    method: "put",
    path: "/admin-api/settings",
    summary: "Update server settings",
    request: { body: json(ServerSettingsUpdateBody) },
    responses: { 200: { description: "OK", ...json(ServerSettings) } },
  });
  registry.registerPath({
    method: "get",
    path: "/admin-api/attention",
    summary: "Items needing attention",
    responses: { 200: { description: "OK", ...json(z.array(AttentionItem)) } },
  });
  registry.registerPath({
    method: "get",
    path: "/admin-api/hwaccel",
    summary: "Hardware acceleration status (detected, read-only)",
    responses: { 200: { description: "OK", ...json(AdminHwaccelStatus) } },
  });

 // Media files
  registry.registerPath({
    method: "get",
    path: "/media-files/{id}/fonts",
    summary: "Fonts referenced by a media file's subtitle tracks",
    request: { params: MediaFileParams },
    responses: { 200: { description: "OK", ...json(MediaFileFontsResponse) } },
  });
  registry.registerPath({
    method: "get",
    path: "/media-files/{id}/tracks",
    summary: "Audio and subtitle tracks for a media file",
    request: { params: MediaFileParams },
    responses: {
      200: { description: "OK", ...json(MediaFileTracksResponse) },
      404: { description: "Media file not found", ...json(MediaFileErrorResponse) },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/media-files/{id}/trickplay",
    summary: "Scrubber-preview (trickplay) sheet index for a media file",
    request: { params: MediaFileParams },
    responses: {
      200: { description: "OK", ...json(MediaFileTrickplayResponse) },
      404: { description: "Media file or trickplay sheets not found", ...json(MediaFileErrorResponse) },
    },
  });

 // Downloads — offline playback for native clients
  registry.registerPath({
    method: "post",
    path: "/downloads",
    summary: "Create an offline download (original or transcoded variant) for a device",
    request: { body: json(DownloadCreateBody) },
    responses: {
      201: { description: "Created — job queued", ...json(DownloadInfo) },
      404: { description: "Media file or device not found", ...json(DownloadErrorResponse) },
      422: { description: "Unsupported combination (e.g. bitmap subtitle on an original variant)", ...json(DownloadErrorResponse) },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/downloads",
    summary: "List the account's downloads (optionally scoped to one device)",
    request: { query: DownloadListQuery },
    responses: { 200: { description: "OK", ...json(z.array(DownloadInfo)) } },
  });
  registry.registerPath({
    method: "get",
    path: "/downloads/{id}",
    summary: "Download status",
    request: { params: DownloadParams },
    responses: {
      200: { description: "OK", ...json(DownloadInfo) },
      404: { description: "Download not found", ...json(DownloadErrorResponse) },
    },
  });
  registry.registerPath({
    method: "delete",
    path: "/downloads/{id}",
    summary: "Remove a download (cancels a queued job and deletes the artifact)",
    request: { params: DownloadParams },
    responses: {
      200: { description: "OK", ...json(RevokedResponse) },
      404: { description: "Download not found", ...json(DownloadErrorResponse) },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/downloads/{id}/artifact",
    summary: "Packaged artifact manifest: media + sidecar subtitles + fonts",
    request: { params: DownloadParams },
    responses: {
      200: { description: "OK", ...json(DownloadArtifactManifest) },
      404: { description: "Download or artifact not ready", ...json(DownloadErrorResponse) },
    },
  });

 // Binary routes — raw bytes, typed as strings in the generated client
  registry.registerPath({
    method: "get",
    path: "/media-files/{id}/direct",
    summary: "Raw media file bytes (Direct Play / download source), Range-enabled",
    request: { params: MediaFileParams },
    responses: {
      200: { description: "File bytes", ...binary("video/mp4") },
      404: { description: "Media file not found", ...json(MediaFileErrorResponse) },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/media-files/{id}/subtitle-tracks/{trackId}",
    summary: "Subtitle track text (external sidecar or extracted on demand)",
    request: { params: z.object({ id: z.string(), trackId: z.string() }) },
    responses: {
      200: { description: "Subtitle text", ...binary("text/vtt") },
      404: { description: "Track not found", ...json(MediaFileErrorResponse) },
    },
  });
  registry.registerPath({
    method: "get",
    path: "/media-files/{id}/trickplay/sheets/{index}",
    summary: "Trickplay sprite sheet bytes",
    request: { params: z.object({ id: z.string(), index: z.string() }) },
    responses: { 200: { description: "JPEG sheet", ...binary("image/jpeg") } },
  });
  registry.registerPath({
    method: "get",
    path: "/fonts/{hash}",
    summary: "Font bytes (hash-keyed, cacheable forever)",
    request: { params: z.object({ hash: z.string() }) },
    responses: { 200: { description: "Font bytes", ...binary("font/woff2") } },
  });
  registry.registerPath({
    method: "get",
    path: "/artwork/{id}",
    summary: "Artwork bytes",
    request: { params: z.object({ id: z.string() }) },
    responses: { 200: { description: "Image bytes", ...binary("image/jpeg") } },
  });
  registry.registerPath({
    method: "get",
    path: "/playback/{sessionId}/playlist.m3u8",
    summary: "HLS playlist for a transcoding session",
    request: { params: PlaybackSessionParams },
    responses: { 200: { description: "m3u8", ...binary("application/vnd.apple.mpegurl") } },
  });
  registry.registerPath({
    method: "get",
    path: "/playback/{sessionId}/stream.mp4",
    summary: "Fragmented-MP4 remux stream (Range-enabled)",
    request: { params: PlaybackSessionParams },
    responses: { 200: { description: "video/mp4", ...binary("video/mp4") } },
  });
  registry.registerPath({
    method: "get",
    path: "/playback/{sessionId}/segment-{n}.ts",
    summary: "HLS segment bytes for a transcoding session",
    request: { params: z.object({ sessionId: z.string(), n: z.string() }) },
    responses: { 200: { description: "MPEG-TS segment", ...binary("video/mp2t") } },
  });
  registry.registerPath({
    method: "get",
    path: "/downloads/{id}/artifact/media",
    summary: "Downloaded media bytes (Range-enabled)",
    request: { params: DownloadParams },
    responses: { 200: { description: "video/mp4", ...binary("video/mp4") } },
  });
  registry.registerPath({
    method: "get",
    path: "/downloads/{id}/artifact/subtitles/{trackId}",
    summary: "Downloaded subtitle sidecar bytes",
    request: { params: DownloadSubtitleParams },
    responses: { 200: { description: "Subtitle text", ...binary("text/vtt") } },
  });
  registry.registerPath({
    method: "get",
    path: "/downloads/{id}/artifact/fonts/{hash}",
    summary: "Downloaded font bytes",
    request: { params: DownloadFontParams },
    responses: { 200: { description: "Font bytes", ...binary("font/woff2") } },
  });

  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: "3.0.0",
    info: { title: "hokago API", version: "0.0.0" },
  });
}
