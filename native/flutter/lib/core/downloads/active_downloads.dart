import 'package:flutter_riverpod/flutter_riverpod.dart';

class PendingDownload {
  final String downloadId;
  final String title;
  final String? posterUrl;
  final double progress; // 0..1, or -1 while the server is still building the artifact
  const PendingDownload({required this.downloadId, required this.title, this.posterUrl, this.progress = -1});

  PendingDownload copyWith({double? progress}) =>
      PendingDownload(downloadId: downloadId, title: title, posterUrl: posterUrl, progress: progress ?? this.progress);
}

/// In-progress downloads only — DownloadManager removes an entry here the
/// moment it lands in OfflineManifest, so DownloadsScreen just concatenates
/// "active" (this) + "done" (offlineEntriesProvider) with no overlap.
class ActiveDownloadsController extends StateNotifier<Map<String, PendingDownload>> {
  ActiveDownloadsController() : super({});

  void start(String downloadId, {required String title, String? posterUrl}) {
    state = {...state, downloadId: PendingDownload(downloadId: downloadId, title: title, posterUrl: posterUrl)};
  }

  void updateProgress(String downloadId, double progress) {
    final existing = state[downloadId];
    if (existing == null) return;
    state = {...state, downloadId: existing.copyWith(progress: progress)};
  }

  void remove(String downloadId) {
    if (!state.containsKey(downloadId)) return;
    state = {...state}..remove(downloadId);
  }
}

final activeDownloadsProvider = StateNotifierProvider<ActiveDownloadsController, Map<String, PendingDownload>>(
  (ref) => ActiveDownloadsController(),
);
