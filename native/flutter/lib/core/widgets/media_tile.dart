import 'package:flutter/material.dart';

import '../api/models/browse.dart';
import '../theme/app_theme.dart';
import 'auth_image.dart';

/// Poster tile — the base unit of every rail/grid, matching the web app's
/// card language (16px tile radius, title below, year/kind meta).
class MediaTile extends StatelessWidget {
  const MediaTile({super.key, required this.item, required this.onTap, this.width = 132});

  final MediaCard item;
  final VoidCallback onTap;
  final double width;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: width,
      child: GestureDetector(
        onTap: onTap,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            AspectRatio(
              aspectRatio: 2 / 3,
              child: AuthImage(url: item.posterUrl, borderRadius: BorderRadius.circular(HokagoRadii.tile)),
            ),
            const SizedBox(height: 6),
            Text(item.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: HokagoText.cardTitle),
            if (item.year != null) Text('${item.year}', style: HokagoText.small),
          ],
        ),
      ),
    );
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
      padding: const EdgeInsets.only(bottom: 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.baseline,
              textBaseline: TextBaseline.alphabetic,
              children: [
                Text(title, style: HokagoText.section),
                if (subtitle != null) ...[
                  const SizedBox(width: 8),
                  Text(subtitle!, style: HokagoText.meta),
                ],
              ],
            ),
          ),
          const SizedBox(height: 10),
          SizedBox(
            height: 236,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              padding: const EdgeInsets.symmetric(horizontal: 16),
              itemCount: items.length,
              separatorBuilder: (_, __) => const SizedBox(width: 12),
              itemBuilder: (_, i) => MediaTile(item: items[i], onTap: () => onTapItem(items[i])),
            ),
          ),
        ],
      ),
    );
  }
}
