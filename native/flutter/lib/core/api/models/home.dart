import 'browse.dart';
import 'playback.dart';

/// Mirrors packages/contract/src/home.ts.
class HomeSlide {
  final String kind; // CONTINUE | THIS_SEASON | RECENTLY_ADDED
  final String label;
  final String title;
  final String? sub;
  final int? year;
  final String? posterUrl;
  final String? backdropUrl;
  final double? progress;
  final String? timeLeftLabel;
  final String? detailId;
  final String? mediaItemId;
  final String? mediaFileId;

  HomeSlide({
    required this.kind,
    required this.label,
    required this.title,
    required this.sub,
    required this.year,
    required this.posterUrl,
    required this.backdropUrl,
    required this.progress,
    required this.timeLeftLabel,
    required this.detailId,
    required this.mediaItemId,
    required this.mediaFileId,
  });

  factory HomeSlide.fromJson(Map<String, dynamic> j) => HomeSlide(
        kind: j['kind'] as String,
        label: j['label'] as String,
        title: j['title'] as String,
        sub: j['sub'] as String?,
        year: j['year'] as int?,
        posterUrl: j['posterUrl'] as String?,
        backdropUrl: j['backdropUrl'] as String?,
        progress: (j['progress'] as num?)?.toDouble(),
        timeLeftLabel: j['timeLeftLabel'] as String?,
        detailId: j['detailId'] as String?,
        mediaItemId: j['mediaItemId'] as String?,
        mediaFileId: j['mediaFileId'] as String?,
      );
}

class HomeRow {
  final String id;
  final String title;
  final String? subtitle;
  final List<MediaCard> items;

  HomeRow({required this.id, required this.title, required this.subtitle, required this.items});

  factory HomeRow.fromJson(Map<String, dynamic> j) => HomeRow(
        id: j['id'] as String,
        title: j['title'] as String,
        subtitle: j['subtitle'] as String?,
        items: (j['items'] as List? ?? const []).map((e) => MediaCard.fromJson(e as Map<String, dynamic>)).toList(),
      );
}

class HomeResponse {
  final List<ContinueWatchingEntry> continueWatching;
  final List<HomeSlide> slides;
  final List<HomeRow> rows;

  HomeResponse({required this.continueWatching, required this.slides, required this.rows});

  factory HomeResponse.fromJson(Map<String, dynamic> j) => HomeResponse(
        continueWatching: (j['continueWatching'] as List? ?? const [])
            .map((e) => ContinueWatchingEntry.fromJson(e as Map<String, dynamic>))
            .toList(),
        slides: (j['slides'] as List? ?? const []).map((e) => HomeSlide.fromJson(e as Map<String, dynamic>)).toList(),
        rows: (j['rows'] as List? ?? const []).map((e) => HomeRow.fromJson(e as Map<String, dynamic>)).toList(),
      );
}
