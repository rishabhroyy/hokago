/// Mirrors packages/contract/src/playback.ts.
class DeviceProfile {
  final List<String> supportedContainers;
  final List<String> supportedVideoCodecs;
  final List<String> supportedAudioCodecs;
  final int? maxVideoBitrateKbps;
  final int? maxWidth;
  final int? maxHeight;
  final bool? supportsHdr;
  final String subtitleMode; // none | external | burn
  final bool? enableDirectPlay;
  final bool? enableDirectStream;

  const DeviceProfile({
    required this.supportedContainers,
    required this.supportedVideoCodecs,
    required this.supportedAudioCodecs,
    this.maxVideoBitrateKbps,
    this.maxWidth,
    this.maxHeight,
    this.supportsHdr,
    required this.subtitleMode,
    this.enableDirectPlay,
    this.enableDirectStream,
  });

  Map<String, dynamic> toJson() => {
        'supportedContainers': supportedContainers,
        'supportedVideoCodecs': supportedVideoCodecs,
        'supportedAudioCodecs': supportedAudioCodecs,
        if (maxVideoBitrateKbps != null) 'maxVideoBitrateKbps': maxVideoBitrateKbps,
        if (maxWidth != null) 'maxWidth': maxWidth,
        if (maxHeight != null) 'maxHeight': maxHeight,
        if (supportsHdr != null) 'supportsHdr': supportsHdr,
        'subtitleMode': subtitleMode,
        if (enableDirectPlay != null) 'enableDirectPlay': enableDirectPlay,
        if (enableDirectStream != null) 'enableDirectStream': enableDirectStream,
      };

  /// media_kit (libmpv) plays effectively anything and renders ASS natively —
  /// the device profile exists so the server can still choose DIRECT_PLAY
  /// whenever possible (cheapest for the server) with wide codec/container
  /// support declared. burn-in subtitleMode: libmpv handles text/ASS subs
  /// itself once tracks are added, so we never need server burn-in for text
  /// formats — only bitmap (PGS/VOBSUB) forces it, same as the web client.
  static const native = DeviceProfile(
    supportedContainers: ['mp4', 'mkv', 'webm', 'mov'],
    supportedVideoCodecs: ['h264', 'hevc', 'vp9', 'av1'],
    supportedAudioCodecs: ['aac', 'ac3', 'eac3', 'opus', 'flac', 'mp3', 'dts'],
    supportsHdr: true,
    subtitleMode: 'external',
    enableDirectPlay: true,
    enableDirectStream: true,
  );
}

class StartPlaybackResponse {
  final String sessionId;
  final String method; // DIRECT_PLAY | DIRECT_STREAM | REMUX | TRANSCODE
  final String? playlistUrl;
  final String? streamUrl;
  final int resumePositionMs;
  final int absoluteDurationMs;
  final int? actualStartMs;

  StartPlaybackResponse({
    required this.sessionId,
    required this.method,
    required this.playlistUrl,
    required this.streamUrl,
    required this.resumePositionMs,
    required this.absoluteDurationMs,
    required this.actualStartMs,
  });

  factory StartPlaybackResponse.fromJson(Map<String, dynamic> j) => StartPlaybackResponse(
        sessionId: j['sessionId'] as String,
        method: j['method'] as String,
        playlistUrl: j['playlistUrl'] as String?,
        streamUrl: j['streamUrl'] as String?,
        resumePositionMs: j['resumePositionMs'] as int? ?? 0,
        absoluteDurationMs: j['absoluteDurationMs'] as int? ?? 0,
        actualStartMs: j['actualStartMs'] as int?,
      );
}

class SeekResponse {
  final bool restarted;
  final int segmentFrom;
  final int? actualStartMs;
  SeekResponse({required this.restarted, required this.segmentFrom, required this.actualStartMs});
  factory SeekResponse.fromJson(Map<String, dynamic> j) => SeekResponse(
        restarted: j['restarted'] as bool,
        segmentFrom: j['segmentFrom'] as int,
        actualStartMs: j['actualStartMs'] as int?,
      );
}

class AudioTrackSwitchResponse {
  final bool restarted;
  final int segmentFrom;
  final int? actualStartMs;
  AudioTrackSwitchResponse({required this.restarted, required this.segmentFrom, required this.actualStartMs});
  factory AudioTrackSwitchResponse.fromJson(Map<String, dynamic> j) => AudioTrackSwitchResponse(
        restarted: j['restarted'] as bool,
        segmentFrom: j['segmentFrom'] as int,
        actualStartMs: j['actualStartMs'] as int?,
      );
}

class MediaItemRef {
  final String id;
  final String kind;
  final String title;
  final String? parentId;
  final int? seasonNumber;
  final int? episodeNumber;
  final int? year;
  final String? posterUrl;
  final String? backdropUrl;
  final String? mediaFileId;

  MediaItemRef({
    required this.id,
    required this.kind,
    required this.title,
    required this.parentId,
    required this.seasonNumber,
    required this.episodeNumber,
    required this.year,
    required this.posterUrl,
    required this.backdropUrl,
    required this.mediaFileId,
  });

  factory MediaItemRef.fromJson(Map<String, dynamic> j) => MediaItemRef(
        id: j['id'] as String,
        kind: j['kind'] as String,
        title: j['title'] as String,
        parentId: j['parentId'] as String?,
        seasonNumber: j['seasonNumber'] as int?,
        episodeNumber: j['episodeNumber'] as int?,
        year: j['year'] as int?,
        posterUrl: j['posterUrl'] as String?,
        backdropUrl: j['backdropUrl'] as String?,
        mediaFileId: j['mediaFileId'] as String?,
      );
}

class ContinueWatchingEntry {
  final MediaItemRef mediaItem;
  final String? seriesTitle;
  final String detailItemId;
  final int positionMs;
  final int? durationMs;
  final bool upNext;

  ContinueWatchingEntry({
    required this.mediaItem,
    required this.seriesTitle,
    required this.detailItemId,
    required this.positionMs,
    required this.durationMs,
    required this.upNext,
  });

  factory ContinueWatchingEntry.fromJson(Map<String, dynamic> j) => ContinueWatchingEntry(
        mediaItem: MediaItemRef.fromJson(j['mediaItem'] as Map<String, dynamic>),
        seriesTitle: j['seriesTitle'] as String?,
        detailItemId: j['detailItemId'] as String,
        positionMs: j['positionMs'] as int,
        durationMs: j['durationMs'] as int?,
        upNext: j['upNext'] as bool? ?? false,
      );
}
