import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/models/browse.dart';
import '../../core/session/session_controller.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/media_tile.dart';

final libraryItemsProvider = FutureProvider.autoDispose.family<List<MediaCard>, String>((ref, libraryId) {
  return ref.read(sessionProvider.notifier).api.libraryItems(libraryId);
});

class LibraryScreen extends ConsumerWidget {
  const LibraryScreen({super.key, required this.libraryId});
  final String libraryId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final items = ref.watch(libraryItemsProvider(libraryId));
    return Scaffold(
      appBar: AppBar(title: const Text('Library')),
      body: items.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('$e', style: HokagoText.meta)),
        data: (cards) => GridView.builder(
          padding: const EdgeInsets.all(16),
          gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
            maxCrossAxisExtent: 150,
            mainAxisSpacing: 20,
            crossAxisSpacing: 14,
            childAspectRatio: 0.54,
          ),
          itemCount: cards.length,
          itemBuilder: (_, i) {
            final tag = 'poster:${cards[i].id}';
            return MediaTile(
              item: cards[i],
              heroTag: tag,
              onTap: () => context.push('/title/${cards[i].id}', extra: (heroTag: tag, posterUrl: cards[i].posterUrl)),
            );
          },
        ),
      ),
    );
  }
}
