import 'dart:async';

import 'package:background_downloader/background_downloader.dart';

import '../api/hokago_api.dart';
import '../api/token_store.dart';
import 'offline_manifest.dart';

/// Real, OS-managed downloads — resumable, notification-driven, survives app
/// kill (iOS background URLSession / Android WorkManager under the hood via
/// background_downloader). Mirrors the request/poll/fetch-artifact flow in
/// apps/web/src/downloads.ts, but the actual byte transfer is native instead
/// of a single in-webview fetch.
class DownloadManager {
  DownloadManager(this._api);
  final HokagoApi _api;

  static const _pollInterval = Duration(seconds: 2);
  static const _pollTimeout = Duration(minutes: 15);

  final _progress = StreamController<(String downloadId, double progress)>.broadcast();
  Stream<(String, double)> get progress => _progress.stream;

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
  }) async {
    final created = await _api.createDownload(
      mediaItemId: mediaItemId,
      mediaFileId: mediaFileId,
      deviceId: deviceId,
      subtitleTrackIds: subtitleTrackIds,
    );
    final downloadId = created.id;

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
    final headers = access != null ? {'Authorization': 'Bearer $access'} : <String, String>{};

    final task = DownloadTask(
      taskId: downloadId,
      url: _api.resolve('/downloads/$downloadId/artifact/media'),
      filename: media.filename,
      headers: headers,
      baseDirectory: BaseDirectory.applicationDocuments,
      directory: 'hokago',
      updates: Updates.statusAndProgress,
    );

    final result = await FileDownloader().download(
      task,
      onProgress: (p) => _progress.add((downloadId, p)),
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
          headers: headers,
          baseDirectory: BaseDirectory.applicationDocuments,
          directory: 'hokago',
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
  }

  Future<void> deleteDownload(String downloadId) async {
    await OfflineManifest.instance.remove(downloadId);
    try {
      await _api.deleteDownload(downloadId);
    } catch (_) {
      // server row cleanup is best-effort — local copy is already gone
    }
  }

  void dispose() => _progress.close();
}
