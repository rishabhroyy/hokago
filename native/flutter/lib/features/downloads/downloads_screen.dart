import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/downloads/offline_manifest.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/auth_image.dart';
import '../../core/widgets/hokago_panel.dart';
import 'offline_watch_screen.dart';

/// The on-device offline library — mirrors apps/web/src/views/OfflineView.tsx.
/// Ground truth is the filesystem (reconcile() drops entries whose file
/// vanished), not the server's download row.
final offlineEntriesProvider = FutureProvider.autoDispose((ref) => OfflineManifest.instance.reconcile());

String _fmtBytes(int n) {
  if (n < 1024) return '$n B';
  if (n < 1024 * 1024) return '${(n / 1024).toStringAsFixed(0)} KB';
  if (n < 1024 * 1024 * 1024) return '${(n / 1024 / 1024).toStringAsFixed(1)} MB';
  return '${(n / 1024 / 1024 / 1024).toStringAsFixed(2)} GB';
}

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
                    Container(
                      width: 56,
                      height: 56,
                      decoration: BoxDecoration(color: HokagoColors.paper2, borderRadius: BorderRadius.circular(18), border: Border.all(color: HokagoColors.line)),
                      child: Icon(Icons.wifi_off_rounded, color: HokagoColors.wiiDeep, size: 24),
                    ),
                    const SizedBox(height: 16),
                    Text('Nothing saved yet', style: HokagoText.section),
                    const SizedBox(height: 6),
                    Text(
                      'Hit the download button on any movie or episode while online — it lands here and plays even with no server reachable.',
                      textAlign: TextAlign.center,
                      style: HokagoText.body,
                    ),
                  ],
                ),
              ),
            );
          }
          return ListView.separated(
            padding: const EdgeInsets.all(16),
            itemCount: items.length,
            separatorBuilder: (_, __) => const SizedBox(height: 12),
            itemBuilder: (_, i) {
              final e = items[i];
              return GestureDetector(
                onTap: () => Navigator.of(context).push(
                  MaterialPageRoute(builder: (_) => OfflineWatchScreen(localPath: e.localPath, title: e.title)),
                ),
                child: HokagoPanel(
                  borderRadius: 22,
                  padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                  child: Row(
                    children: [
                      SizedBox(
                        width: 48,
                        height: 68,
                        child: ClipRRect(borderRadius: BorderRadius.circular(10), child: AuthImage(url: e.posterUrl)),
                      ),
                      const SizedBox(width: 14),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(e.title, style: HokagoText.cardTitle, maxLines: 1, overflow: TextOverflow.ellipsis),
                            const SizedBox(height: 2),
                            Text(e.subtitle ?? _fmtBytes(e.sizeBytes), style: HokagoText.meta),
                          ],
                        ),
                      ),
                      Icon(Icons.play_circle_outline_rounded, color: HokagoColors.wiiDeep),
                      const SizedBox(width: 4),
                      IconButton(
                        icon: Icon(Icons.delete_outline_rounded, color: HokagoColors.ink3),
                        onPressed: () async {
                          await OfflineManifest.instance.remove(e.downloadId);
                          ref.invalidate(offlineEntriesProvider);
                        },
                      ),
                    ],
                  ),
                ),
              );
            },
          );
        },
      ),
    );
  }
}
