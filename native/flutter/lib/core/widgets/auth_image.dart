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
    final placeholder = Container(color: HokagoColors.card);
    if (url == null || session.serverUrl == null) {
      return ClipRRect(borderRadius: borderRadius ?? BorderRadius.zero, child: placeholder);
    }
    final resolved = url!.startsWith('http') ? url! : '${session.serverUrl}$url';
    final image = CachedNetworkImage(
      imageUrl: resolved,
      httpHeaders: session.accessToken != null ? {'Authorization': 'Bearer ${session.accessToken}'} : null,
      fit: fit,
      placeholder: (_, __) => placeholder,
      errorWidget: (_, __, ___) => Container(
        color: HokagoColors.card,
        alignment: Alignment.center,
        child: const Icon(Icons.movie_creation_outlined, color: HokagoColors.ink3),
      ),
    );
    return borderRadius != null ? ClipRRect(borderRadius: borderRadius!, child: image) : image;
  }
}
