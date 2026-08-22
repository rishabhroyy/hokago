import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/downloads/offline_manifest.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/auth_image.dart';

/// The on-device offline library — mirrors apps/web/src/views/OfflineView.tsx.
/// Ground truth is the filesystem (reconcile() drops entries whose file
/// vanished), not the server's download row.
final offlineEntriesProvider = FutureProvider.autoDispose((ref) => OfflineManifest.instance.reconcile());

class DownloadsScreen extends ConsumerWidget {
  const DownloadsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final entries = ref.watch(offlineEntriesProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Downloads')),
      body: entries.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('$e', style: HokagoText.meta)),
        data: (items) {
          if (items.isEmpty) {
            return Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const Icon(Icons.download_outlined, color: HokagoColors.ink3, size: 40),
                    const SizedBox(height: 12),
                    Text('Nothing downloaded yet', style: HokagoText.body),
                    const SizedBox(height: 4),
                    Text('Save an episode or movie from its detail page to watch it offline.',
                        textAlign: TextAlign.center, style: HokagoText.meta),
                  ],
                ),
              ),
            );
          }
          return ListView.builder(
            padding: const EdgeInsets.symmetric(vertical: 8),
            itemCount: items.length,
            itemBuilder: (_, i) {
              final e = items[i];
              return ListTile(
                leading: SizedBox(
                  width: 48,
                  height: 68,
                  child: AuthImage(url: e.posterUrl, borderRadius: BorderRadius.circular(8)),
                ),
                title: Text(e.title, style: HokagoText.cardTitle, maxLines: 1, overflow: TextOverflow.ellipsis),
                subtitle: Text(
                  e.subtitle ?? '${(e.sizeBytes / (1024 * 1024)).toStringAsFixed(0)} MB',
                  style: HokagoText.meta,
                ),
                trailing: IconButton(
                  icon: const Icon(Icons.delete_outline, color: HokagoColors.ink3),
                  onPressed: () async {
                    await OfflineManifest.instance.remove(e.downloadId);
                    ref.invalidate(offlineEntriesProvider);
                  },
                ),
              );
            },
          );
        },
      ),
    );
  }
}
