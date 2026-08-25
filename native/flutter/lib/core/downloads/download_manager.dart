import 'dart:async';

import 'package:background_downloader/background_downloader.dart';
import 'package:dio/dio.dart';

import '../api/hokago_api.dart';
import '../api/token_store.dart';
import 'active_downloads.dart';
import 'offline_manifest.dart';

/// The access token baked into a [DownloadTask]'s headers is a snapshot —
/// background_downloader hands the OS (URLSession / WorkManager) a static
/// header and no automatic refresh happens the way HokagoApiClient's Dio
/// interceptor does for in-app requests. Access tokens are short-lived
/// (ACCESS_TOKEN_TTL = 15m, apps/api/src/auth.ts) and real media downloads —
/// large files, background-throttled transfers, spotty mobile networks —
/// routinely outlive that, so every download that takes longer than 15
/// minutes end to end 401s and dies with no way to recover. [Auth.onAuth] is
/// background_downloader's own extension point for exactly this: the native
/// side calls it before a task (re)starts if the token looks expired, and
/// substitutes the refreshed `{accessToken}` placeholder into the request
/// headers. Must be a top-level function — the plugin invokes it via a
/// callback handle from a background isolate, which rules out a closure or
/// instance method.
@pragma('vm:entry-point')
Future<Task?> _hokagoRefreshDownloadAuth(Task original) async {
  final auth = original.options?.auth;
  if (auth == null) return null;
  final serverUrl = await TokenStore.instance.serverUrl;
  final refreshToken = await TokenStore.instance.refreshToken;
  if (serverUrl == null || refreshToken == null) return null;
  try {
    final res = await Dio(BaseOptions(baseUrl: serverUrl)).post('/auth/refresh', data: {'refreshToken': refreshToken});
    final accessToken = res.data['accessToken'] as String;
    await TokenStore.instance.setAccessToken(accessToken);
    auth.accessToken = accessToken;
    final remainingMs = TokenStore.expiresInMs(accessToken);
    if (remainingMs != null) auth.accessTokenExpiryTime = DateTime.now().add(Duration(milliseconds: remainingMs));
    return original;
  } catch (_) {
    // Refresh token itself is dead (revoked/expired) — nothing to recover;
    // the task fails and surfaces normally.
    return null;
  }
}

/// Real, OS-managed downloads — resumable, notification-driven, survives app
/// kill (iOS background URLSession / Android WorkManager under the hood via
/// background_downloader). Mirrors the request/poll/fetch-artifact flow in
/// apps/web/src/downloads.ts, but the actual byte transfer is native instead
/// of a single in-webview fetch.
class DownloadManager {
  DownloadManager(this._api, this._active);
  final HokagoApi _api;
  final ActiveDownloadsController _active;

  static const _pollInterval = Duration(seconds: 2);
  static const _pollTimeout = Duration(minutes: 15);

  /// [maxHeight]/[maxBitrateKbps]: request the transcode variant (smaller
  /// file, server re-encodes). Both null: original — the raw file, copied.
  Future<void> downloadItem({
    required String mediaItemId,
    required String mediaFileId,
    required String deviceId,
    required String title,
    required String kind,
    String? subtitle,
    String? posterUrl,
    int? durationMs,
    List<String>? subtitleTrackIds,
    int? maxHeight,
    int? maxBitrateKbps,
  }) async {
    final created = await _api.createDownload(
      mediaItemId: mediaItemId,
      mediaFileId: mediaFileId,
      deviceId: deviceId,
      subtitleTrackIds: subtitleTrackIds,
      maxHeight: maxHeight,
      maxBitrateKbps: maxBitrateKbps,
    );
    final downloadId = created.id;
    _active.start(downloadId, title: subtitle != null ? '$title — $subtitle' : title, posterUrl: posterUrl);

    try {
      final started = DateTime.now();
      var status = created.status;
      while (status != 'READY' && status != 'FAILED') {
        if (DateTime.now().difference(started) > _pollTimeout) {
          throw TimeoutException('download $downloadId never became ready');
        }
        await Future.delayed(_pollInterval);
        final polled = await _api.downloadStatus(downloadId);
        status = polled.status;
      }
      if (status == 'FAILED') throw Exception('server-side download failed');

      final manifest = await _api.downloadArtifact(downloadId);
      final media = manifest.media;
      if (media == null) throw Exception('download artifact has no media file');

      final access = await TokenStore.instance.accessToken;
      // Auth (not a static header) so a token that expires mid-transfer —
      // routine for a real media file, see _hokagoRefreshDownloadAuth above —
      // gets refreshed instead of silently 401ing the download. retries: so
      // a transient network blip (equally routine on mobile networks over
      // the minutes-to-hours a large file can take) doesn't kill the whole
      // download either.
      Auth authFor(String? accessToken) {
        final remainingMs = accessToken != null ? TokenStore.expiresInMs(accessToken) : null;
        return Auth(
          accessToken: accessToken,
          accessHeaders: const {'Authorization': 'Bearer {accessToken}'},
          accessTokenExpiryTime: remainingMs != null ? DateTime.now().add(Duration(milliseconds: remainingMs)) : null,
          onAuth: _hokagoRefreshDownloadAuth,
        );
      }

      final task = DownloadTask(
        taskId: downloadId,
        url: _api.resolve('/downloads/$downloadId/artifact/media'),
        filename: media.filename,
        baseDirectory: BaseDirectory.applicationDocuments,
        directory: 'hokago',
        updates: Updates.statusAndProgress,
        retries: 5,
        options: TaskOptions(auth: authFor(access)),
      );

      final result = await FileDownloader().download(
        task,
        onProgress: (p) => _active.updateProgress(downloadId, p),
      );
      if (result.status != TaskStatus.complete) {
        throw Exception('download failed: ${result.status}');
      }
      final localPath = await task.filePath();

      // Sidecar subtitles/fonts ride along best-effort — a failure here
      // shouldn't fail the whole download, the media file is already saved.
      for (final sub in manifest.subtitles) {
        try {
          final subTask = DownloadTask(
            url: _api.resolve('/downloads/$downloadId/artifact/subtitles/${sub.trackId}'),
            filename: sub.filename,
            baseDirectory: BaseDirectory.applicationDocuments,
            directory: 'hokago',
            retries: 3,
            options: TaskOptions(auth: authFor(access)),
          );
          await FileDownloader().download(subTask);
        } catch (_) {
          // best-effort sidecar
        }
      }

      await OfflineManifest.instance.record(OfflineEntry(
        downloadId: downloadId,
        mediaItemId: mediaItemId,
        mediaFileId: mediaFileId,
        title: title,
        kind: kind,
        subtitle: subtitle,
        posterUrl: posterUrl,
        durationMs: durationMs,
        localPath: localPath,
        sizeBytes: media.sizeBytes ?? 0,
      ));
    } finally {
      _active.remove(downloadId);
    }
  }

  Future<void> deleteDownload(String downloadId) async {
    await OfflineManifest.instance.remove(downloadId);
    try {
      await _api.deleteDownload(downloadId);
    } catch (_) {
      // server row cleanup is best-effort — local copy is already gone
    }
  }
}
