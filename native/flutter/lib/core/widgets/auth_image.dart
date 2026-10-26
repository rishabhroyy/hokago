import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../session/session_controller.dart';
import '../theme/app_theme.dart';

/// Poster/backdrop image from the configured server, sent with the bearer
/// token (hokago serves all artwork from its own origin, every route authed).
///
/// Decoded at the size it's laid out at (memCacheWidth) — the server only
/// stores full-size art, and decoding a 2000px poster per 130px tile is what
/// made long rails stutter and blow the image cache.
class AuthImage extends ConsumerWidget {
  const AuthImage({super.key, required this.url, this.fit = BoxFit.cover, this.alignment = Alignment.center, this.fallback});

  final String? url;
  final BoxFit fit;
  final Alignment alignment;

  /// Shown when there's no url or the fetch fails. Defaults to a plain card fill.
  final Widget? fallback;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // select(): rebuild on server change only — the 4-minute token warmth
    // would otherwise rebuild every image on screen.
    final serverUrl = ref.watch(sessionProvider.select((s) => s.serverUrl));
    final empty = fallback ?? const ColoredBox(color: HokagoColors.card, child: SizedBox.expand());
    if (url == null || serverUrl == null) return empty;
    final token = ref.read(sessionProvider).accessToken;
    final resolved = url!.startsWith('http') ? url! : '$serverUrl$url';
    return LayoutBuilder(
      builder: (context, c) {
        // Cap the decode on the box's *long* side: with cover-fit that keeps
        // both image dimensions >= the box whatever the art's aspect (a 16:9
        // backdrop in the tall phone hero would blur if capped by width).
        final dpr = MediaQuery.devicePixelRatioOf(context);
        final bounded = c.hasBoundedWidth && c.hasBoundedHeight;
        final tall = bounded && c.maxHeight > c.maxWidth;
        final w = bounded && !tall ? (c.maxWidth * dpr).round() : null;
        final h = tall ? (c.maxHeight * dpr).round() : null;
        return CachedNetworkImage(
          imageUrl: resolved,
          httpHeaders: token != null ? {'Authorization': 'Bearer $token'} : null,
          fit: fit,
          alignment: alignment,
          width: double.infinity,
          height: double.infinity,
          memCacheWidth: w,
          memCacheHeight: h,
          fadeInDuration: const Duration(milliseconds: 260),
          fadeOutDuration: Duration.zero,
          filterQuality: FilterQuality.medium,
          placeholder: (_, _) => const ColoredBox(color: HokagoColors.card, child: SizedBox.expand()),
          errorWidget: (_, _, _) => empty,
        );
      },
    );
  }
}
