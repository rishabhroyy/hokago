/// Mirrors packages/contract/src/downloads.ts.
class DownloadInfo {
  final String id;
  final String mediaItemId;
  final String mediaFileId;
  final String deviceId;
  final String variant; // original | transcode
  final List<String> subtitleTrackIds;
  final String status; // QUEUED | PROCESSING | READY | FAILED
  final int? sizeBytes;
  final String? error;

  DownloadInfo({
    required this.id,
    required this.mediaItemId,
    required this.mediaFileId,
    required this.deviceId,
    required this.variant,
    required this.subtitleTrackIds,
    required this.status,
    required this.sizeBytes,
    required this.error,
  });

  factory DownloadInfo.fromJson(Map<String, dynamic> j) => DownloadInfo(
        id: j['id'] as String,
        mediaItemId: j['mediaItemId'] as String,
        mediaFileId: j['mediaFileId'] as String,
        deviceId: j['deviceId'] as String,
        variant: j['variant'] as String,
        subtitleTrackIds: (j['subtitleTrackIds'] as List? ?? const []).cast<String>(),
        status: j['status'] as String,
        sizeBytes: j['sizeBytes'] as int?,
        error: j['error'] as String?,
      );
}

class DownloadArtifactMedia {
  final String filename;
  final String url;
  final int? sizeBytes;
  DownloadArtifactMedia({required this.filename, required this.url, required this.sizeBytes});
  factory DownloadArtifactMedia.fromJson(Map<String, dynamic> j) =>
      DownloadArtifactMedia(filename: j['filename'] as String, url: j['url'] as String, sizeBytes: j['sizeBytes'] as int?);
}

class DownloadArtifactSubtitle {
  final String trackId;
  final String filename;
  final String format;
  final String? lang;
  DownloadArtifactSubtitle({required this.trackId, required this.filename, required this.format, required this.lang});
  factory DownloadArtifactSubtitle.fromJson(Map<String, dynamic> j) => DownloadArtifactSubtitle(
        trackId: j['trackId'] as String,
        filename: j['filename'] as String,
        format: j['format'] as String,
        lang: j['lang'] as String?,
      );
}

class DownloadArtifactFont {
  final String hash;
  final String filename;
  final String url;
  DownloadArtifactFont({required this.hash, required this.filename, required this.url});
  factory DownloadArtifactFont.fromJson(Map<String, dynamic> j) =>
      DownloadArtifactFont(hash: j['hash'] as String, filename: j['filename'] as String, url: j['url'] as String);
}

class DownloadArtifactManifest {
  final DownloadArtifactMedia? media;
  final List<DownloadArtifactSubtitle> subtitles;
  final List<DownloadArtifactFont> fonts;
  DownloadArtifactManifest({required this.media, required this.subtitles, required this.fonts});
  factory DownloadArtifactManifest.fromJson(Map<String, dynamic> j) => DownloadArtifactManifest(
        media: j['media'] != null ? DownloadArtifactMedia.fromJson(j['media'] as Map<String, dynamic>) : null,
        subtitles:
            (j['subtitles'] as List? ?? const []).map((e) => DownloadArtifactSubtitle.fromJson(e as Map<String, dynamic>)).toList(),
        fonts: (j['fonts'] as List? ?? const []).map((e) => DownloadArtifactFont.fromJson(e as Map<String, dynamic>)).toList(),
      );
}
