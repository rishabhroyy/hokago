import 'package:flutter/material.dart';

import '../api/models/browse.dart';
import '../theme/app_theme.dart';
import '../theme/hue.dart';
import 'auth_image.dart';

/// The "wii channel" tile — ui/Tile.tsx ported: a glossy card-colored frame
/// (5px padding, 20px outer / 15px inner radius) around the poster, a
/// deterministic pastel hue-gradient fallback when there's no art, kicker-
/// style meta line below the bold title. This — not a plain rounded image —
/// is hokago's actual card language.
class MediaTile extends StatelessWidget {
  const MediaTile({super.key, required this.item, required this.onTap, this.width, this.subLabel});

  final MediaCard item;
  final VoidCallback onTap;
  /// Forces intrinsic width — needed inside an unconstrained horizontal
  /// ListView (MediaRail). Leave null inside a GridView, which already gives
  /// a tight width per cell; forcing a mismatched SizedBox there overflows.
  final double? width;
  final String? subLabel;

  @override
  Widget build(BuildContext context) {
    final hue = hueFor(item.id);
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
                child: AspectRatio(
                  aspectRatio: 2 / 3,
                  child: ClipRRect(
                    borderRadius: BorderRadius.circular(15),
                    child: item.posterUrl != null
                        ? AuthImage(url: item.posterUrl)
                        : DecoratedBox(
                            decoration: BoxDecoration(gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: hue)),
                            child: const Center(child: Icon(Icons.movie_creation_rounded, color: Colors.white, size: 40)),
                          ),
                  ),
                ),
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
  const MediaRail({super.key, required this.title, required this.items, required this.onTapItem, this.subtitle});

  final String title;
  final String? subtitle;
  final List<MediaCard> items;
  final void Function(MediaCard) onTapItem;

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
                    gradient: const LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [HokagoColors.wii2, HokagoColors.wiiDeep]),
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
              itemBuilder: (_, i) => MediaTile(item: items[i], width: 140, onTap: () => onTapItem(items[i])),
            ),
          ),
        ],
      ),
    );
  }
}
