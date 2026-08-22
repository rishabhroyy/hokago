import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/models/browse.dart';
import '../../core/session/session_controller.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/auth_image.dart';

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
        error: (e, _) => Center(child: Text('$e', style: const TextStyle(color: HokagoColors.ink2))),
        data: (cards) => GridView.builder(
          padding: const EdgeInsets.all(16),
          gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
            maxCrossAxisExtent: 140,
            mainAxisSpacing: 16,
            crossAxisSpacing: 12,
            childAspectRatio: 0.56,
          ),
          itemCount: cards.length,
          itemBuilder: (_, i) => _GridTile(item: cards[i], onTap: () => context.push('/title/${cards[i].id}')),
        ),
      ),
    );
  }
}

class _GridTile extends StatelessWidget {
  const _GridTile({required this.item, required this.onTap});
  final MediaCard item;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: AuthImage(url: item.posterUrl, borderRadius: BorderRadius.circular(HokagoRadii.tile)),
          ),
          const SizedBox(height: 6),
          Text(item.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
        ],
      ),
    );
  }
}
