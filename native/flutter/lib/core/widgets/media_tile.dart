import 'package:flutter/material.dart';

import '../api/models/browse.dart';
import '../api/models/playback.dart';
import '../theme/app_theme.dart';
import '../theme/hue.dart';
import 'auth_image.dart';
import 'hokago_icon.dart';
import 'pressable.dart';
import 'zoom_open.dart';

/// Phones get smaller tiles than the web's 172/240px rails; tablets and TVs
/// (>= 820 logical px, the web's own breakpoint) get the web sizes.
bool isWide(BuildContext context) => MediaQuery.sizeOf(context).width >= 820;
double pageGutter(BuildContext context) => isWide(context) ? 48 : 20;

/// ui/Tile.tsx's TileItem — the one shape every rail and grid renders.
class TileItem {
  const TileItem({
    required this.id,
    required this.title,
    required this.subLabel,
    this.posterUrl,
    this.landscape = false,
    this.badge,
    this.progress,
    this.detailId,
  });

  final String id;
  final String title;
  final String subLabel;
  final String? posterUrl;
  final bool landscape;
  final String? badge;
  final double? progress;

  /// Detail page to land on — the series for an episode, else the item itself.
  final String? detailId;
}

String kindLabel(String kind) => switch (kind) {
      'MOVIE' => 'Movie',
      'SERIES' => 'Series',
      'SEASON' => 'Season',
      _ => 'Episode',
    };

/// ui/tile-mapping.ts's cardToTile.
TileItem cardToTile(MediaCard item) => TileItem(
      id: item.id,
      title: item.title,
      posterUrl: item.posterUrl,
      subLabel: [kindLabel(item.kind), if (item.year != null) '${item.year}'].join(', '),
      badge: item.isDownloaded ? null : 'Not downloaded',
    );

/// ui/tile-mapping.ts's continueWatchingToTile: the rail is landscape when it
/// can be (backdrop), and tapping lands on the series, not the episode.
TileItem continueWatchingToTile(ContinueWatchingEntry entry) {
  final item = entry.mediaItem;
  final isEpisode = item.kind == 'EPISODE' && item.seasonNumber != null && item.episodeNumber != null;
  final duration = entry.durationMs;
  return TileItem(
    id: item.id,
    title: item.title,
    posterUrl: item.backdropUrl ?? item.posterUrl,
    landscape: item.kind == 'EPISODE' || item.backdropUrl != null,
    subLabel: isEpisode
        ? ['S${item.seasonNumber} E${item.episodeNumber}', if (entry.seriesTitle?.isNotEmpty ?? false) entry.seriesTitle!].join(', ')
        : kindLabel(item.kind),
    detailId: entry.detailItemId,
    badge: entry.upNext ? 'Up next' : null,
    progress: !entry.upNext && duration != null && duration > 0 ? entry.positionMs / duration : null,
  );
}

/// Art with the deterministic pastel + glyph fallback (Tile.tsx's no-poster branch).
class ChannelArt extends StatelessWidget {
  const ChannelArt({super.key, required this.id, required this.url, this.radius = 15, this.iconScale = 0.38, this.dim = false});
  final String id;
  final String? url;
  final double radius;
  final double iconScale;
  final bool dim;

  @override
  Widget build(BuildContext context) {
    final hue = hueFor(id);
    final fallback = DecoratedBox(
      decoration: BoxDecoration(gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: hue)),
      child: LayoutBuilder(
        builder: (context, c) => Stack(
          fit: StackFit.expand,
          children: [
            const Align(
              alignment: Alignment.topCenter,
              child: FractionallySizedBox(
                heightFactor: 0.46,
                widthFactor: 1,
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.topCenter,
                      end: Alignment.bottomCenter,
                      colors: [Color(0x6BFFFFFF), Color(0x14FFFFFF), Color(0x00FFFFFF)],
                    ),
                  ),
                ),
              ),
            ),
            Center(child: HokagoIcon(iconFor(id), size: c.biggest.shortestSide * iconScale, color: Colors.white.withValues(alpha: 0.95))),
          ],
        ),
      ),
    );
    return ClipRRect(
      borderRadius: BorderRadius.circular(radius),
      child: Stack(
        fit: StackFit.expand,
        children: [
          url != null ? AuthImage(url: url, fallback: fallback) : fallback,
          if (dim) const ColoredBox(color: Color(0x73121110)),
          // ring-1 ring-inset ring-white/20
          IgnorePointer(
            child: DecoratedBox(
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(radius),
                border: Border.all(color: Colors.white.withValues(alpha: 0.12)),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The "wii channel" tile — a card-colored frame (5px, 20/15 radius) around
/// the art, bold title + quiet sub label below. Focus = the Wii blue ring.
class MediaTile extends StatelessWidget {
  const MediaTile({super.key, required this.item, required this.onOpen, this.onLongPress, this.width});

  final TileItem item;
  final VoidCallback onOpen;
  final VoidCallback? onLongPress;

  /// Forces a width (horizontal rails); leave null in grids.
  final double? width;

  @override
  Widget build(BuildContext context) {
    final artKey = GlobalKey();
    final channelColor = Color.lerp(hueFor(item.id).first, Colors.white, 0.12)!;
    final tile = Pressable(
      onTap: () => zoomOpen(context: context, artKey: artKey, color: channelColor, navigate: onOpen),
      onLongPress: onLongPress,
      semanticLabel: item.title,
      builder: (context, focused) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          AnimatedContainer(
            duration: const Duration(milliseconds: 200),
            padding: const EdgeInsets.all(5),
            decoration: BoxDecoration(
              color: HokagoColors.card,
              borderRadius: BorderRadius.circular(20),
              boxShadow: focused ? hokagoWiiRing : hokagoPanelShadow,
            ),
            child: AspectRatio(
              key: artKey,
              aspectRatio: item.landscape ? 16 / 9 : 2 / 3,
              child: Stack(
                fit: StackFit.expand,
                children: [
                  ChannelArt(id: item.id, url: item.posterUrl),
                  if (item.badge != null) Positioned(left: 8, top: 8, child: TileBadge(item.badge!)),
                  if (item.progress != null) Positioned(left: 8, right: 8, bottom: 8, child: WiiProgress(value: item.progress!)),
                ],
              ),
            ),
          ),
          const SizedBox(height: 10),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4),
            child: Text(
              item.title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: HokagoText.cardTitle.copyWith(color: focused ? HokagoColors.wiiDeep : HokagoColors.ink),
            ),
          ),
          const SizedBox(height: 2),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4),
            child: Text(item.subLabel, maxLines: 1, overflow: TextOverflow.ellipsis, style: HokagoText.small),
          ),
        ],
      ),
    );
    return width != null ? SizedBox(width: width, child: tile) : tile;
  }
}

class TileBadge extends StatelessWidget {
  const TileBadge(this.text, {super.key});
  final String text;

  @override
  Widget build(BuildContext context) => DecoratedBox(
        decoration: BoxDecoration(
          color: HokagoColors.paper,
          borderRadius: BorderRadius.circular(HokagoRadii.pill),
          boxShadow: const [BoxShadow(color: Color(0x66000000), blurRadius: 6, spreadRadius: -2, offset: Offset(0, 2))],
        ),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
          child: Text(text, style: HokagoText.small.copyWith(fontWeight: FontWeight.w700, color: HokagoColors.wiiInk)),
        ),
      );
}

/// The glowing Wii-blue progress pill (tiles, hero, episode cards).
class WiiProgress extends StatelessWidget {
  const WiiProgress({super.key, required this.value, this.height = 5});
  final double value;
  final double height;

  @override
  Widget build(BuildContext context) => ClipRRect(
        borderRadius: BorderRadius.circular(HokagoRadii.pill),
        child: Container(
          height: height,
          color: Colors.black.withValues(alpha: 0.35),
          alignment: Alignment.centerLeft,
          child: FractionallySizedBox(
            widthFactor: value.clamp(0.0, 1.0),
            heightFactor: 1,
            child: const DecoratedBox(
              decoration: BoxDecoration(
                borderRadius: BorderRadius.all(Radius.circular(HokagoRadii.pill)),
                gradient: LinearGradient(colors: [HokagoColors.wii2, HokagoColors.wii]),
                boxShadow: [BoxShadow(color: Color(0xE64FB8E0), blurRadius: 6)],
              ),
            ),
          ),
        ),
      );
}

/// Row.tsx's section head: the glowing Wii "channel indicator" bar + title.
class SectionTitle extends StatelessWidget {
  const SectionTitle(this.title, {super.key, this.count, this.trailing});
  final String title;
  final int? count;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        Container(
          width: 6,
          height: 20,
          margin: const EdgeInsets.only(right: 10),
          decoration: const BoxDecoration(
            borderRadius: BorderRadius.all(Radius.circular(3)),
            gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [HokagoColors.wii2, HokagoColors.wiiDeep]),
            boxShadow: [BoxShadow(color: Color(0x994FB8E0), blurRadius: 8)],
          ),
        ),
        Expanded(
          child: Text.rich(
            TextSpan(children: [
              TextSpan(text: title),
              if (count != null)
                TextSpan(text: '  $count', style: HokagoText.meta.copyWith(color: HokagoColors.ink3, fontFeatures: const [FontFeature.tabularFigures()])),
            ]),
            style: HokagoText.section,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ),
        ?trailing,
      ],
    );
  }
}

/// ui/Row.tsx: a titled horizontal rail of tiles.
class MediaRail extends StatelessWidget {
  const MediaRail({super.key, required this.title, required this.items, required this.onOpen, this.onLongPress});

  final String title;
  final List<TileItem> items;
  final void Function(TileItem) onOpen;
  final void Function(TileItem)? onLongPress;

  @override
  Widget build(BuildContext context) {
    if (items.isEmpty) return const SizedBox.shrink();
    final wide = isWide(context);
    final gutter = pageGutter(context);
    final landscape = items.every((i) => i.landscape);
    final tileW = landscape ? (wide ? 240.0 : 208.0) : (wide ? 172.0 : 132.0);
    // art + frame + title/sub block; the vertical padding leaves room for the
    // focus ring and the press/focus scale without clipping.
    final artH = (tileW - 10) / (landscape ? 16 / 9 : 2 / 3) + 10;
    final textH = tileTextHeight(context);
    return Padding(
      padding: EdgeInsets.only(top: wide ? 28 : 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(padding: EdgeInsets.symmetric(horizontal: gutter), child: SectionTitle(title)),
          SizedBox(
            height: artH + textH + 28,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              clipBehavior: Clip.none,
              padding: EdgeInsets.fromLTRB(gutter, 16, gutter, 12),
              itemCount: items.length,
              separatorBuilder: (_, _) => SizedBox(width: wide ? 20 : 14),
              itemBuilder: (_, i) => MediaTile(
                item: items[i],
                width: tileW,
                onOpen: () => onOpen(items[i]),
                onLongPress: onLongPress == null ? null : () => onLongPress!(items[i]),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Title + sub label block under a tile's art, honoring the user's text size.
double tileTextHeight(BuildContext context) {
  final scaler = MediaQuery.textScalerOf(context);
  return 10 + scaler.scale(13.5) * 1.3 + 2 + scaler.scale(12) * 1.4 + 4;
}

/// app.css's `.poster-grid`: auto-fill columns, minmax(128px) on phones,
/// minmax(180px) wide. Row height is computed from the real column width
/// (2:3 art + frame + text), never a guessed aspect ratio.
Widget posterGrid(BuildContext context, {required List<TileItem> items, required void Function(TileItem) onOpen, void Function(TileItem)? onLongPress}) {
  final wide = isWide(context);
  final minCell = wide ? 180.0 : 128.0;
  final gap = wide ? 20.0 : 14.0;
  final textH = tileTextHeight(context);
  return SliverLayoutBuilder(builder: (context, c) {
    final width = c.crossAxisExtent;
    final cols = ((width + gap) / (minCell + gap)).floor().clamp(2, 12);
    final cellW = (width - gap * (cols - 1)) / cols;
    return SliverGrid(
      gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: cols,
        mainAxisSpacing: wide ? 32 : 24,
        crossAxisSpacing: gap,
        mainAxisExtent: (cellW - 10) * 1.5 + 10 + textH,
      ),
      delegate: SliverChildBuilderDelegate(
        (_, i) => MediaTile(
          item: items[i],
          onOpen: () => onOpen(items[i]),
          onLongPress: onLongPress == null ? null : () => onLongPress(items[i]),
        ),
        childCount: items.length,
      ),
    );
  });
}
