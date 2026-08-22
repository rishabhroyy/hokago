import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/session/session_controller.dart';
import '../../core/theme/app_theme.dart';

/// v1: server-side download status list. Native on-device saves
/// (background_downloader), the offline manifest, and offline playback land
/// in a follow-up pass — see docs/native-clients.md.
final downloadsListProvider = FutureProvider.autoDispose((ref) => ref.read(sessionProvider.notifier).api.downloads());

class DownloadsScreen extends ConsumerWidget {
  const DownloadsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final downloads = ref.watch(downloadsListProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Downloads')),
      body: downloads.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('$e', style: const TextStyle(color: HokagoColors.ink2))),
        data: (items) {
          if (items.isEmpty) {
            return const Center(child: Text('Nothing downloaded yet', style: TextStyle(color: HokagoColors.ink3)));
          }
          return ListView.builder(
            itemCount: items.length,
            itemBuilder: (_, i) {
              final d = items[i];
              return ListTile(
                leading: const Icon(Icons.movie_creation_outlined, color: HokagoColors.ink2),
                title: Text(d.mediaItemId, style: const TextStyle(color: HokagoColors.ink)),
                subtitle: Text(d.status, style: const TextStyle(color: HokagoColors.ink3)),
              );
            },
          );
        },
      ),
    );
  }
}
