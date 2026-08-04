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
  SessionSummary,
  SessionParams,
  CreateInviteBody,
  InviteResponse,
  ErrorResponse as AuthErrorResponse,
} from "./auth.js";
import {
  StartPlaybackBody,
  StartPlaybackResponse,
  PlaybackSessionParams,
  SeekBody,
  SeekResponse,
  AudioTrackSwitchBody,
  AudioTrackSwitchResponse,
  HeartbeatBody,
  HeartbeatResponse,
  StopResponse,
  ContinueWatchingQuery,
  ContinueWatchingResponse,
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
  ErrorResponse as AdminErrorResponse,
} from "./admin.js";
import {
  MediaFileParams,
  MediaFileFontsResponse,
  MediaFileTracksResponse,
  ErrorResponse as MediaFileErrorResponse,
} from "./media-files.js";

const json = (schema: z.ZodTypeAny) => ({ content: { "application/json": { schema } } });

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
    request: { params: MediaItemDetailParams },
    responses: {
      200: { description: "OK", ...json(MediaItemDetail) },
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

  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: "3.0.0",
    info: { title: "hokago API", version: "0.0.0" },
  });
}
