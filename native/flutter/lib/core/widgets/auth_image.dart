import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../session/session_controller.dart';
import '../theme/app_theme.dart';

/// Poster/backdrop image, resolved against the configured server and sent
/// with the current bearer token — hokago serves all artwork from its own
/// origin and requires auth on every route.
class AuthImage extends ConsumerWidget {
  const AuthImage({super.key, required this.url, this.fit = BoxFit.cover, this.borderRadius});

  final String? url;
  final BoxFit fit;
  final BorderRadius? borderRadius;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    // Explicit double.infinity on every branch: a bare Container/Image
    // inside a flexible parent (Expanded, Positioned.fill without an
    // ancestor SizedBox) sizes to its *content*, not its constraints,
    // which read as a smaller image with background "lines" down the
    // sides — force fill so cover-fit always covers the whole box.
    final placeholder = Container(width: double.infinity, height: double.infinity, color: HokagoColors.card);
    if (url == null || session.serverUrl == null) {
      return ClipRRect(borderRadius: borderRadius ?? BorderRadius.zero, child: placeholder);
    }
    final resolved = url!.startsWith('http') ? url! : '${session.serverUrl}$url';
    final image = CachedNetworkImage(
      imageUrl: resolved,
      httpHeaders: session.accessToken != null ? {'Authorization': 'Bearer ${session.accessToken}'} : null,
      fit: fit,
      width: double.infinity,
      height: double.infinity,
      placeholder: (_, __) => placeholder,
      errorWidget: (_, __, ___) => Container(
        width: double.infinity,
        height: double.infinity,
        color: HokagoColors.card,
        alignment: Alignment.center,
        child: Icon(Icons.movie_creation_outlined, color: HokagoColors.ink3),
      ),
    );
    return borderRadius != null ? ClipRRect(borderRadius: borderRadius!, child: image) : image;
  }
}
