/// Mirrors packages/contract/src/media-files.ts.
class FontDescriptor {
  final String hash;
  final String family;
  final double? weight;
  final String? style;
  final String url;
  FontDescriptor({required this.hash, required this.family, required this.weight, required this.style, required this.url});
  factory FontDescriptor.fromJson(Map<String, dynamic> j) => FontDescriptor(
        hash: j['hash'] as String,
        family: j['family'] as String,
        weight: (j['weight'] as num?)?.toDouble(),
        style: j['style'] as String?,
        url: j['url'] as String,
      );
}

class MediaFileAudioTrackInfo {
  final int streamIndex;
  final String? codec;
  final String? lang;
  final String? title;
  final bool isDefault;
  MediaFileAudioTrackInfo({
    required this.streamIndex,
    required this.codec,
    required this.lang,
    required this.title,
    required this.isDefault,
  });
  factory MediaFileAudioTrackInfo.fromJson(Map<String, dynamic> j) => MediaFileAudioTrackInfo(
        streamIndex: j['streamIndex'] as int,
        codec: j['codec'] as String?,
        lang: j['lang'] as String?,
        title: j['title'] as String?,
        isDefault: j['isDefault'] as bool? ?? false,
      );
}

class SubtitleTrackInfo {
  final String id;
  final String? lang;
  final String? title;
  final String format;
  final bool forced;
  final bool sdh;
  final bool requiresBurnIn;
  SubtitleTrackInfo({
    required this.id,
    required this.lang,
    required this.title,
    required this.format,
    required this.forced,
    required this.sdh,
    required this.requiresBurnIn,
  });
  factory SubtitleTrackInfo.fromJson(Map<String, dynamic> j) => SubtitleTrackInfo(
        id: j['id'] as String,
        lang: j['lang'] as String?,
        title: j['title'] as String?,
        format: j['format'] as String,
        forced: j['forced'] as bool? ?? false,
        sdh: j['sdh'] as bool? ?? false,
        requiresBurnIn: j['requiresBurnIn'] as bool? ?? false,
      );
}

class MediaFileTracksResponse {
  final List<MediaFileAudioTrackInfo> audio;
  final List<SubtitleTrackInfo> subtitles;
  MediaFileTracksResponse({required this.audio, required this.subtitles});
  factory MediaFileTracksResponse.fromJson(Map<String, dynamic> j) => MediaFileTracksResponse(
        audio: (j['audio'] as List? ?? const []).map((e) => MediaFileAudioTrackInfo.fromJson(e as Map<String, dynamic>)).toList(),
        subtitles:
            (j['subtitles'] as List? ?? const []).map((e) => SubtitleTrackInfo.fromJson(e as Map<String, dynamic>)).toList(),
      );
}

class TrickplaySheet {
  final int index;
  final String url;
  final int tiles;
  TrickplaySheet({required this.index, required this.url, required this.tiles});
  factory TrickplaySheet.fromJson(Map<String, dynamic> j) =>
      TrickplaySheet(index: j['index'] as int, url: j['url'] as String, tiles: j['tiles'] as int);
}

class MediaFileTrickplayResponse {
  final int tileWidth;
  final int tileHeight;
  final int intervalMs;
  final int tilesPerSheet;
  final int cols;
  final List<TrickplaySheet> sheets;
  MediaFileTrickplayResponse({
    required this.tileWidth,
    required this.tileHeight,
    required this.intervalMs,
    required this.tilesPerSheet,
    required this.cols,
    required this.sheets,
  });
  factory MediaFileTrickplayResponse.fromJson(Map<String, dynamic> j) => MediaFileTrickplayResponse(
        tileWidth: j['tileWidth'] as int,
        tileHeight: j['tileHeight'] as int,
        intervalMs: j['intervalMs'] as int,
        tilesPerSheet: j['tilesPerSheet'] as int,
        cols: j['cols'] as int,
        sheets: (j['sheets'] as List? ?? const []).map((e) => TrickplaySheet.fromJson(e as Map<String, dynamic>)).toList(),
      );
}
