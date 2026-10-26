import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/session/session_controller.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/hokago_icon.dart';
import '../../core/widgets/media_tile.dart';

class SheetAction {
  const SheetAction(this.label, this.icon, this.onTap, {this.destructive = false});
  final String label;
  final String icon;
  final VoidCallback onTap;
  final bool destructive;
}

/// The native stand-in for the web's right-click ContextMenu: a bottom
/// sheet of actions, opened by long-press (or the TV menu key).
Future<void> showActionSheet(BuildContext context, {required String title, String? subtitle, required List<SheetAction> actions}) {
  return showModalBottomSheet<void>(
    context: context,
    builder: (sheet) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(title, style: HokagoText.section, maxLines: 2, overflow: TextOverflow.ellipsis),
            if (subtitle != null) ...[const SizedBox(height: 2), Text(subtitle, style: HokagoText.small)],
            const SizedBox(height: 12),
            for (final a in actions)
              ListTile(
                contentPadding: const EdgeInsets.symmetric(horizontal: 8),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
                leading: HokagoIcon(a.icon, size: 20, color: a.destructive ? HokagoColors.accent : HokagoColors.ink2),
                title: Text(a.label, style: HokagoText.cardTitle.copyWith(fontSize: 15, color: a.destructive ? HokagoColors.accent : HokagoColors.ink)),
                onTap: () {
                  Navigator.pop(sheet);
                  a.onTap();
                },
              ),
          ],
        ),
      ),
    ),
  );
}

/// HomeView's tile menu: mark the tile itself, or (for an episode / series
/// tile) every episode of its title, watched or unwatched.
Future<void> showTileActions(BuildContext context, WidgetRef ref, TileItem item, {required VoidCallback onChanged}) {
  final api = ref.read(sessionProvider.notifier).api;
  final profileId = ref.read(sessionProvider).profileId;
  final messenger = ScaffoldMessenger.of(context);

  Future<void> mark(List<String> ids, bool watched) async {
    if (profileId == null) return;
    try {
      await Future.wait(ids.map((id) => api.setWatched(id, profileId: profileId, watched: watched)));
      onChanged();
    } catch (_) {
      messenger.showSnackBar(const SnackBar(content: Text("Couldn't update watch state")));
    }
  }

  Future<void> markTitle(bool watched) async {
    if (profileId == null) return;
    try {
      final detail = await api.mediaItemDetail(item.detailId ?? item.id, profileId: profileId);
      final ids = detail.kind == 'SERIES' ? [...detail.episodes.map((e) => e.id), ...detail.movies.map((e) => e.id)] : [detail.id];
      await mark(ids, watched);
    } catch (_) {
      messenger.showSnackBar(const SnackBar(content: Text("Couldn't update watch state")));
    }
  }

  return showActionSheet(
    context,
    title: item.title,
    subtitle: item.subLabel,
    // A continue-watching tile is one episode of a title: offer both the
    // episode and the whole title. A browse card *is* the title.
    actions: item.detailId != null && item.detailId != item.id
        ? [
            SheetAction('Mark as watched', 'check', () => mark([item.id], true)),
            SheetAction('Unwatch', 'refresh', () => mark([item.id], false)),
            SheetAction('Mark whole title watched', 'check', () => markTitle(true)),
            SheetAction('Unwatch whole title', 'refresh', () => markTitle(false)),
          ]
        : [
            SheetAction('Mark as watched', 'check', () => markTitle(true)),
            SheetAction('Unwatch', 'refresh', () => markTitle(false)),
          ],
  );
}
