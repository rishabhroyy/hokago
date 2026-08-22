/// Mirrors packages/contract/src/browse.ts. Hand-written (no codegen) against
/// the frozen contract — see packages/contract/generated/openapi.json for the
/// source of truth if these drift.
library;

class LibrarySummary {
  final String id;
  final String name;
  final String contentProfile;
  final List<String> mediaKinds;

  LibrarySummary({required this.id, required this.name, required this.contentProfile, required this.mediaKinds});

  factory LibrarySummary.fromJson(Map<String, dynamic> j) => LibrarySummary(
        id: j['id'] as String,
        name: j['name'] as String,
        contentProfile: j['contentProfile'] as String,
        mediaKinds: (j['mediaKinds'] as List).cast<String>(),
      );
}

class MediaCard {
  final String id;
  final String kind; // MOVIE | SERIES | SEASON | EPISODE
  final String title;
  final String sortTitle;
  final int? year;
  final String? posterUrl;
  final String? backdropUrl;
  final String? mediaFileId;
  final bool isDownloaded;
  final List<String> genres;
  final DateTime? createdAt;

  MediaCard({
    required this.id,
    required this.kind,
    required this.title,
    required this.sortTitle,
    required this.year,
    required this.posterUrl,
    required this.backdropUrl,
    required this.mediaFileId,
    required this.isDownloaded,
    required this.genres,
    required this.createdAt,
  });

  factory MediaCard.fromJson(Map<String, dynamic> j) => MediaCard(
        id: j['id'] as String,
        kind: j['kind'] as String,
        title: j['title'] as String,
        sortTitle: j['sortTitle'] as String,
        year: j['year'] as int?,
        posterUrl: j['posterUrl'] as String?,
        backdropUrl: j['backdropUrl'] as String?,
        mediaFileId: j['mediaFileId'] as String?,
        isDownloaded: j['isDownloaded'] as bool? ?? false,
        genres: (j['genres'] as List? ?? const []).cast<String>(),
        createdAt: j['createdAt'] != null ? DateTime.tryParse(j['createdAt'] as String) : null,
      );
}

class EpisodeCard extends MediaCard {
  final int? seasonNumber;
  final int? episodeNumber;
  final int? runtimeMs;
  final bool watched;
  final int positionMs;

  EpisodeCard({
    required super.id,
    required super.kind,
    required super.title,
    required super.sortTitle,
    required super.year,
    required super.posterUrl,
    required super.backdropUrl,
    required super.mediaFileId,
    required super.isDownloaded,
    required super.genres,
    required super.createdAt,
    required this.seasonNumber,
    required this.episodeNumber,
    required this.runtimeMs,
    required this.watched,
    required this.positionMs,
  });

  factory EpisodeCard.fromJson(Map<String, dynamic> j) {
    final card = MediaCard.fromJson(j);
    return EpisodeCard(
      id: card.id,
      kind: card.kind,
      title: card.title,
      sortTitle: card.sortTitle,
      year: card.year,
      posterUrl: card.posterUrl,
      backdropUrl: card.backdropUrl,
      mediaFileId: card.mediaFileId,
      isDownloaded: card.isDownloaded,
      genres: card.genres,
      createdAt: card.createdAt,
      seasonNumber: j['seasonNumber'] as int?,
      episodeNumber: j['episodeNumber'] as int?,
      runtimeMs: j['runtimeMs'] as int?,
      watched: j['watched'] as bool? ?? false,
      positionMs: j['positionMs'] as int? ?? 0,
    );
  }
}

class MediaItemWatch {
  final bool watched;
  final int positionMs;
  final int? durationMs;
  final int playCount;
  final DateTime? lastWatchedAt;

  MediaItemWatch({
    required this.watched,
    required this.positionMs,
    required this.durationMs,
    required this.playCount,
    required this.lastWatchedAt,
  });

  factory MediaItemWatch.fromJson(Map<String, dynamic> j) => MediaItemWatch(
        watched: j['watched'] as bool,
        positionMs: j['positionMs'] as int,
        durationMs: j['durationMs'] as int?,
        playCount: j['playCount'] as int,
        lastWatchedAt: j['lastWatchedAt'] != null ? DateTime.tryParse(j['lastWatchedAt'] as String) : null,
      );
}

class DetailAudioTrack {
  final int streamIndex;
  final String? lang;
  DetailAudioTrack({required this.streamIndex, required this.lang});
  factory DetailAudioTrack.fromJson(Map<String, dynamic> j) =>
      DetailAudioTrack(streamIndex: j['streamIndex'] as int, lang: j['lang'] as String?);
}

class CollectionEntry {
  final String relationType;
  final String? anchor;
  final MediaCard item;
  CollectionEntry({required this.relationType, required this.anchor, required this.item});
  factory CollectionEntry.fromJson(Map<String, dynamic> j) => CollectionEntry(
        relationType: j['relationType'] as String,
        anchor: j['anchor'] as String?,
        item: MediaCard.fromJson(j['item'] as Map<String, dynamic>),
      );
}

class MediaCollection {
  final String id;
  final String name;
  final String kind; // FRANCHISE | MOVIE_SET
  final String? posterUrl;
  final String relationType;
  final List<CollectionEntry> entries;
  MediaCollection({
    required this.id,
    required this.name,
    required this.kind,
    required this.posterUrl,
    required this.relationType,
    required this.entries,
  });
  factory MediaCollection.fromJson(Map<String, dynamic> j) => MediaCollection(
        id: j['id'] as String,
        name: j['name'] as String,
        kind: j['kind'] as String,
        posterUrl: j['posterUrl'] as String?,
        relationType: j['relationType'] as String,
        entries: (j['entries'] as List? ?? const [])
            .map((e) => CollectionEntry.fromJson(e as Map<String, dynamic>))
            .toList(),
      );
}

class MediaItemDetail extends MediaCard {
  final String? overview;
  final String? originalTitle;
  final double? rating;
  final String? studio;
  final List<MediaCard> children;
  final List<EpisodeCard> episodes;
  final List<EpisodeCard> movies;
  final List<DetailAudioTrack> audioTracks;
  final MediaItemWatch? watch;
  final List<MediaCollection> collections;

  MediaItemDetail({
    required super.id,
    required super.kind,
    required super.title,
    required super.sortTitle,
    required super.year,
    required super.posterUrl,
    required super.backdropUrl,
    required super.mediaFileId,
    required super.isDownloaded,
    required super.genres,
    required super.createdAt,
    required this.overview,
    required this.originalTitle,
    required this.rating,
    required this.studio,
    required this.children,
    required this.episodes,
    required this.movies,
    required this.audioTracks,
    required this.watch,
    required this.collections,
  });

  factory MediaItemDetail.fromJson(Map<String, dynamic> j) {
    final card = MediaCard.fromJson(j);
    return MediaItemDetail(
      id: card.id,
      kind: card.kind,
      title: card.title,
      sortTitle: card.sortTitle,
      year: card.year,
      posterUrl: card.posterUrl,
      backdropUrl: card.backdropUrl,
      mediaFileId: card.mediaFileId,
      isDownloaded: card.isDownloaded,
      genres: card.genres,
      createdAt: card.createdAt,
      overview: j['overview'] as String?,
      originalTitle: j['originalTitle'] as String?,
      rating: (j['rating'] as num?)?.toDouble(),
      studio: j['studio'] as String?,
      children: (j['children'] as List? ?? const []).map((e) => MediaCard.fromJson(e as Map<String, dynamic>)).toList(),
      episodes: (j['episodes'] as List? ?? const []).map((e) => EpisodeCard.fromJson(e as Map<String, dynamic>)).toList(),
      movies: (j['movies'] as List? ?? const []).map((e) => EpisodeCard.fromJson(e as Map<String, dynamic>)).toList(),
      audioTracks:
          (j['audioTracks'] as List? ?? const []).map((e) => DetailAudioTrack.fromJson(e as Map<String, dynamic>)).toList(),
      watch: j['watch'] != null ? MediaItemWatch.fromJson(j['watch'] as Map<String, dynamic>) : null,
      collections:
          (j['collections'] as List? ?? const []).map((e) => MediaCollection.fromJson(e as Map<String, dynamic>)).toList(),
    );
  }
}

class MediaFileVideoInfo {
  final String? codec;
  final int? width;
  final int? height;
  final double? frameRate;
  final bool isHdr;
  MediaFileVideoInfo({required this.codec, required this.width, required this.height, required this.frameRate, required this.isHdr});
  factory MediaFileVideoInfo.fromJson(Map<String, dynamic> j) => MediaFileVideoInfo(
        codec: j['codec'] as String?,
        width: j['width'] as int?,
        height: j['height'] as int?,
        frameRate: (j['frameRate'] as num?)?.toDouble(),
        isHdr: j['isHdr'] as bool? ?? false,
      );
}

class MediaFileDescriptor {
  final String mediaFileId;
  final bool isPrimary;
  final String? container;
  final int? durationMs;
  final int? sizeBytes;
  final int? bitrate;
  final MediaFileVideoInfo? video;

  MediaFileDescriptor({
    required this.mediaFileId,
    required this.isPrimary,
    required this.container,
    required this.durationMs,
    required this.sizeBytes,
    required this.bitrate,
    required this.video,
  });

  factory MediaFileDescriptor.fromJson(Map<String, dynamic> j) => MediaFileDescriptor(
        mediaFileId: j['mediaFileId'] as String,
        isPrimary: j['isPrimary'] as bool? ?? false,
        container: j['container'] as String?,
        durationMs: j['durationMs'] as int?,
        sizeBytes: j['sizeBytes'] as int?,
        bitrate: j['bitrate'] as int?,
        video: j['video'] != null ? MediaFileVideoInfo.fromJson(j['video'] as Map<String, dynamic>) : null,
      );
}
