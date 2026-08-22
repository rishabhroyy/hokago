import 'package:flutter/material.dart';

import '../api/models/browse.dart';
import '../api/models/playback.dart';
import '../theme/app_theme.dart';
import '../theme/hue.dart';
import 'auth_image.dart';

/// The "wii channel" tile — ui/Tile.tsx ported: a glossy card-colored frame
/// (5px padding, 20px outer / 15px inner radius) around the poster, a
/// deterministic pastel hue-gradient fallback when there's no art, kicker-
/// style meta line below the bold title. This — not a plain rounded image —
/// is hokago's actual card language.
class MediaTile extends StatelessWidget {
  const MediaTile({
    super.key,
    required this.item,
    required this.onTap,
    this.width,
    this.subLabel,
    this.heroTag,
    this.posterUrlOverride,
    this.landscape = false,
    this.progress,
    this.badge,
  });

  final MediaCard item;
  final VoidCallback onTap;
  /// Forces intrinsic width — needed inside an unconstrained horizontal
  /// ListView (MediaRail). Leave null inside a GridView, which already gives
  /// a tight width per cell; forcing a mismatched SizedBox there overflows.
  final double? width;
  final String? subLabel;
  /// Ties this tile's art to DetailScreen's poster for a shared-element
  /// zoom (Tile.tsx's zoomOpen). Omit for rows where the same item can
  /// appear twice on one screen (Hero + a rail) — Hero tags must be unique.
  final Object? heroTag;
  /// ui/tile-mapping.ts's continueWatchingToTile: a continuing episode shows
  /// its backdrop, not its poster — landscape reads as "watched so far".
  final String? posterUrlOverride;
  final bool landscape;
  final double? progress;
  final String? badge;

  @override
  Widget build(BuildContext context) {
    final hue = hueFor(item.id);
    final art = posterUrlOverride ?? item.posterUrl;
    final artBox = AspectRatio(
      aspectRatio: landscape ? 16 / 9 : 2 / 3,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(15),
        child: Stack(
          fit: StackFit.expand,
          children: [
            art != null
                ? AuthImage(url: art)
                : DecoratedBox(
                    decoration: BoxDecoration(gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: hue)),
                    child: const Center(child: Icon(Icons.movie_creation_rounded, color: Colors.white, size: 40)),
                  ),
            if (badge != null)
              Positioned(
                left: 8,
                top: 8,
                child: DecoratedBox(
                  decoration: BoxDecoration(color: Colors.white.withValues(alpha: 0.95), borderRadius: BorderRadius.circular(999)),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                    child: Text(badge!, style: HokagoText.kicker.copyWith(color: HokagoColors.ink, fontWeight: FontWeight.w700)),
                  ),
                ),
              ),
            if (progress != null)
              Positioned(
                left: 8,
                right: 8,
                bottom: 8,
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(999),
                  child: Container(
                    height: 5,
                    color: Colors.black.withValues(alpha: 0.25),
                    alignment: Alignment.centerLeft,
                    child: FractionallySizedBox(
                      widthFactor: progress!.clamp(0, 1),
                      child: DecoratedBox(decoration: BoxDecoration(gradient: LinearGradient(colors: [HokagoColors.wii2, HokagoColors.wiiDeep]))),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
    final column = GestureDetector(
      onTap: onTap,
      child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            DecoratedBox(
              decoration: BoxDecoration(
                color: HokagoColors.card,
                borderRadius: BorderRadius.circular(20),
                boxShadow: const [
                  BoxShadow(color: Color(0x73000000), blurRadius: 6, spreadRadius: -2, offset: Offset(0, 2)),
                  BoxShadow(color: Color(0x99000000), blurRadius: 20, spreadRadius: -10, offset: Offset(0, 10)),
                ],
              ),
              child: Padding(
                padding: const EdgeInsets.all(5),
                child: heroTag != null ? Hero(tag: heroTag!, child: artBox) : artBox,
              ),
            ),
            const SizedBox(height: 8),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 2),
              child: Text(item.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: HokagoText.cardTitle),
            ),
            if (subLabel != null || item.year != null)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 2),
                child: Text((subLabel ?? '${item.year}').toUpperCase(),
                    maxLines: 1, overflow: TextOverflow.ellipsis, style: HokagoText.kicker.copyWith(color: HokagoColors.ink3)),
              ),
          ],
        ),
    );
    return width != null ? SizedBox(width: width, child: column) : column;
  }
}

class MediaRail extends StatelessWidget {
  const MediaRail({super.key, required this.railId, required this.title, required this.items, required this.onTapItem, this.subtitle});

  /// Qualifies each tile's Hero tag ('poster:$railId:$itemId') — the same
  /// title can appear in two different rails on Home at once, and Flutter
  /// throws if two mounted Heroes ever share a tag.
  final String railId;
  final String title;
  final String? subtitle;
  final List<MediaCard> items;
  final void Function(MediaCard item, String heroTag) onTapItem;

  @override
  Widget build(BuildContext context) {
    if (items.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 12, bottom: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                // The "channel indicator" accent bar — Row.tsx's ::before pseudo-element.
                Container(
                  width: 5,
                  height: 18,
                  margin: const EdgeInsets.only(right: 10),
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(3),
                    gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [HokagoColors.wii2, HokagoColors.wiiDeep]),
                    boxShadow: const [BoxShadow(color: Color(0x9963C3E6), blurRadius: 6)],
                  ),
                ),
                Expanded(child: Text(title, style: HokagoText.section)),
                if (subtitle != null) Text(subtitle!, style: HokagoText.meta),
              ],
            ),
          ),
          const SizedBox(height: 10),
          SizedBox(
            height: 244,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 16),
              itemCount: items.length,
              separatorBuilder: (_, __) => const SizedBox(width: 14),
              itemBuilder: (_, i) {
                final tag = 'poster:$railId:${items[i].id}';
                return MediaTile(item: items[i], width: 140, heroTag: tag, onTap: () => onTapItem(items[i], tag));
              },
            ),
          ),
        ],
      ),
    );
  }
}

/// Continue watching's Row — same "wii channel" tile, but episodes render
/// landscape (backdrop) with a resume progress bar / NEXT badge, and tapping
/// lands on the parent series' detail page, not the episode itself. Mirrors
/// ui/tile-mapping.ts's continueWatchingToTile.
class ContinueWatchingRail extends StatelessWidget {
  const ContinueWatchingRail({super.key, required this.entries, required this.onTapEntry});

  final List<ContinueWatchingEntry> entries;
  // No Hero tag here: this tile shows the episode's landscape backdrop while
  // DetailScreen always shows the parent series' portrait poster — flying
  // between two different images would look like a glitch, not a zoom.
  final void Function(ContinueWatchingEntry entry) onTapEntry;

  @override
  Widget build(BuildContext context) {
    if (entries.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 12, bottom: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                Container(
                  width: 5,
                  height: 18,
                  margin: const EdgeInsets.only(right: 10),
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(3),
                    gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [HokagoColors.wii2, HokagoColors.wiiDeep]),
                    boxShadow: const [BoxShadow(color: Color(0x9963C3E6), blurRadius: 6)],
                  ),
                ),
                Expanded(child: Text('Continue watching', style: HokagoText.section)),
              ],
            ),
          ),
          const SizedBox(height: 10),
          SizedBox(
            height: 244,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 16),
              itemCount: entries.length,
              separatorBuilder: (_, __) => const SizedBox(width: 14),
              itemBuilder: (_, i) {
                final entry = entries[i];
                final item = entry.mediaItem;
                final isEpisode = item.kind == 'EPISODE';
                final subLabel = isEpisode && item.seasonNumber != null && item.episodeNumber != null
                    ? [entry.seriesTitle, 'S${item.seasonNumber}·E${item.episodeNumber}'].where((s) => s != null && s.isNotEmpty).join(' · ')
                    : item.kind[0] + item.kind.substring(1).toLowerCase();
                final progress = !entry.upNext && entry.durationMs != null && entry.durationMs! > 0 ? entry.positionMs / entry.durationMs! : null;
                return MediaTile(
                  item: MediaCard(
                    id: item.id,
                    kind: item.kind,
                    title: item.title,
                    sortTitle: item.title,
                    year: item.year,
                    posterUrl: item.posterUrl,
                    backdropUrl: item.backdropUrl,
                    mediaFileId: item.mediaFileId,
                    isDownloaded: false,
                    genres: const [],
                    createdAt: null,
                  ),
                  width: 140,
                  subLabel: subLabel,
                  posterUrlOverride: isEpisode ? (item.backdropUrl ?? item.posterUrl) : item.posterUrl,
                  landscape: isEpisode,
                  progress: progress,
                  badge: entry.upNext ? 'NEXT' : null,
                  onTap: () => onTapEntry(entry),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}
