import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/downloads/active_downloads.dart';
import '../../core/downloads/download_providers.dart';
import '../../core/downloads/offline_manifest.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/hokago_icon.dart';
import '../../core/widgets/hokago_panel.dart';
import '../../core/widgets/media_tile.dart';
import '../../core/widgets/pressable.dart';
import '../common/states.dart';
import '../common/tile_actions.dart';
import 'offline_watch_screen.dart';

/// The on-device offline library — OfflineView.tsx. Saved entries' ground
/// truth is the filesystem (reconcile() drops vanished files); in-progress
/// downloads ride on top with live progress.
final offlineEntriesProvider = FutureProvider.autoDispose((ref) => OfflineManifest.instance.reconcile());

String _fmtBytes(int n) {
  if (n < 1024 * 1024) return '${(n / 1024).toStringAsFixed(0)} KB';
  if (n < 1024 * 1024 * 1024) return '${(n / 1024 / 1024).toStringAsFixed(1)} MB';
  return '${(n / 1024 / 1024 / 1024).toStringAsFixed(2)} GB';
}

class DownloadsScreen extends ConsumerWidget {
  const DownloadsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final entries = ref.watch(offlineEntriesProvider);
    final active = ref.watch(activeDownloadsProvider);
    // An active download disappearing = finished (now in the manifest) or failed.
    ref.listen(activeDownloadsProvider, (prev, next) {
      if (prev != null && prev.length > next.length) ref.invalidate(offlineEntriesProvider);
    });
    final gutter = pageGutter(context);
    final items = entries.value ?? const <OfflineEntry>[];
    final total = items.fold<int>(0, (s, e) => s + e.sizeBytes);

    return Scaffold(
      body: CustomScrollView(
        slivers: [
          SliverPadding(
            padding: EdgeInsets.fromLTRB(gutter, MediaQuery.paddingOf(context).top + 28, gutter, 20),
            sliver: SliverToBoxAdapter(
              child: PageHeader('Downloads', count: items.isEmpty ? null : items.length, sub: items.isEmpty ? null : '${_fmtBytes(total)} on this device'),
            ),
          ),
          if (entries.hasValue && items.isEmpty && active.isEmpty)
            const SliverFillRemaining(
              hasScrollBody: false,
              child: MessageState(
                icon: 'wifi-off',
                title: 'Nothing saved yet',
                message: 'Tap Download on any movie or episode while online — it lands here and plays with no server in reach.',
              ),
            )
          else
            SliverPadding(
              padding: EdgeInsets.symmetric(horizontal: gutter),
              sliver: SliverList.list(children: [
                for (final p in active.values) Padding(padding: const EdgeInsets.only(bottom: 12), child: _ActiveRow(pending: p)),
                for (final e in items)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: _SavedRow(
                      entry: e,
                      onPlay: () => Navigator.of(context, rootNavigator: true).push(MaterialPageRoute(builder: (_) => OfflineWatchScreen(entry: e))),
                      onMenu: () => showActionSheet(context, title: e.title, subtitle: e.subtitle, actions: [
                        SheetAction('Delete from this device', 'trash', destructive: true, () async {
                          await ref.read(downloadManagerProvider).deleteDownload(e.downloadId);
                          ref.invalidate(offlineEntriesProvider);
                        }),
                      ]),
                    ),
                  ),
              ]),
            ),
          SliverPadding(padding: EdgeInsets.only(bottom: MediaQuery.paddingOf(context).bottom + 24)),
        ],
      ),
    );
  }
}

class _Thumb extends StatelessWidget {
  const _Thumb({required this.id, required this.url});
  final String id;
  final String? url;
  @override
  Widget build(BuildContext context) => Container(
        width: 58,
        padding: const EdgeInsets.all(3),
        decoration: BoxDecoration(color: HokagoColors.card, borderRadius: BorderRadius.circular(14)),
        child: AspectRatio(aspectRatio: 2 / 3, child: ChannelArt(id: id, url: url, radius: 11)),
      );
}

class _SavedRow extends StatelessWidget {
  const _SavedRow({required this.entry, required this.onPlay, required this.onMenu});
  final OfflineEntry entry;
  final VoidCallback onPlay;
  final VoidCallback onMenu;

  @override
  Widget build(BuildContext context) {
    return Pressable(
      onTap: onPlay,
      onLongPress: onMenu,
      pressedScale: 0.98,
      semanticLabel: entry.title,
      builder: (context, focused) => HokagoPanel(
        borderRadius: 22,
        padding: const EdgeInsets.fromLTRB(10, 10, 6, 10),
        child: Row(children: [
          _Thumb(id: entry.mediaItemId, url: entry.posterUrl),
          const SizedBox(width: 14),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(entry.title, style: HokagoText.cardTitle.copyWith(fontSize: 14.5, color: focused ? HokagoColors.wiiDeep : HokagoColors.ink), maxLines: 1, overflow: TextOverflow.ellipsis),
              if (entry.subtitle != null) Text(entry.subtitle!, style: HokagoText.meta, maxLines: 1, overflow: TextOverflow.ellipsis),
              const SizedBox(height: 2),
              Text(_fmtBytes(entry.sizeBytes), style: HokagoText.small),
            ]),
          ),
          Container(
            width: 40,
            height: 40,
            decoration: const BoxDecoration(
              shape: BoxShape.circle,
              gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [HokagoColors.wiiBtnTop, HokagoColors.wiiBtnBottom]),
            ),
            alignment: Alignment.center,
            child: const Padding(padding: EdgeInsets.only(left: 2), child: HokagoIcon('play', size: 16, color: Colors.white)),
          ),
          IconButton(tooltip: 'More', onPressed: onMenu, icon: const HokagoIcon('list', size: 18, color: HokagoColors.ink3)),
        ]),
      ),
    );
  }
}

class _ActiveRow extends StatelessWidget {
  const _ActiveRow({required this.pending});
  final PendingDownload pending;

  @override
  Widget build(BuildContext context) {
    final building = pending.progress < 0;
    return HokagoPanel(
      borderRadius: 22,
      padding: const EdgeInsets.all(10),
      child: Row(children: [
        _Thumb(id: pending.downloadId, url: pending.posterUrl),
        const SizedBox(width: 14),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(pending.title, style: HokagoText.cardTitle.copyWith(fontSize: 14.5), maxLines: 1, overflow: TextOverflow.ellipsis),
            const SizedBox(height: 8),
            building
                ? ClipRRect(borderRadius: BorderRadius.circular(3), child: const LinearProgressIndicator(minHeight: 5))
                : WiiProgress(value: pending.progress, height: 5),
            const SizedBox(height: 6),
            Text(building ? 'The server is preparing the file…' : '${(pending.progress * 100).round()}%', style: HokagoText.small),
          ]),
        ),
        const SizedBox(width: 8),
      ]),
    );
  }
}
