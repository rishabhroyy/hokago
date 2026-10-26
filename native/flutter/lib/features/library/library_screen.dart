import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/models/browse.dart';
import '../../core/session/session_controller.dart';
import '../../core/theme/app_theme.dart';
import '../../core/theme/hue.dart';
import '../../core/widgets/hokago_icon.dart';
import '../../core/widgets/media_tile.dart';
import '../../core/widgets/pressable.dart';
import '../../core/widgets/skeleton.dart';
import '../../core/widgets/wii_button.dart';
import '../common/states.dart';
import '../common/tile_actions.dart';

final librariesProvider = FutureProvider.autoDispose<List<LibrarySummary>>((ref) => ref.read(sessionProvider.notifier).api.libraries());

/// LibraryView.tsx keeps the server's sortTitle order but floats downloaded
/// titles first (stable sort, so each group stays alphabetical).
final libraryItemsProvider = FutureProvider.autoDispose.family<List<MediaCard>, String>((ref, libraryId) async {
  final list = await ref.read(sessionProvider.notifier).api.libraryItems(libraryId);
  return stableSort(list, (a, b) => (b.isDownloaded ? 1 : 0) - (a.isDownloaded ? 1 : 0));
});

List<T> stableSort<T>(List<T> list, int Function(T, T) compare) {
  // List.sort isn't guaranteed stable; index-tiebreak makes it so.
  final indexed = [for (var i = 0; i < list.length; i++) (i, list[i])];
  indexed.sort((a, b) {
    final c = compare(a.$2, b.$2);
    return c != 0 ? c : a.$1 - b.$1;
  });
  return [for (final e in indexed) e.$2];
}

String _libraryIcon(LibrarySummary lib) {
  if (lib.contentProfile == 'ANIME') return 'sparkle';
  if (lib.mediaKinds.length == 1 && lib.mediaKinds.first == 'MOVIE') return 'film';
  return 'tv';
}

/// The Library tab: every library as a glossy pastel "channel" card (the
/// web's TopNav library links, given a home on a phone).
class LibrariesScreen extends ConsumerWidget {
  const LibrariesScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final libs = ref.watch(librariesProvider);
    final gutter = pageGutter(context);
    final top = MediaQuery.paddingOf(context).top;
    return Scaffold(
      body: RefreshIndicator(
        onRefresh: () => ref.refresh(librariesProvider.future),
        child: CustomScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: [
            SliverPadding(
              padding: EdgeInsets.fromLTRB(gutter, top + 28, gutter, 20),
              sliver: const SliverToBoxAdapter(child: PageHeader('Library')),
            ),
            switch (libs) {
              AsyncData(:final value) when value.isEmpty => const SliverFillRemaining(
                  hasScrollBody: false,
                  child: MessageState(icon: 'lib', title: 'No libraries yet', message: 'An admin can add one from the web admin panel.'),
                ),
              AsyncData(:final value) => SliverPadding(
                  padding: EdgeInsets.symmetric(horizontal: gutter),
                  sliver: SliverGrid(
                    gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(maxCrossAxisExtent: 420, mainAxisSpacing: 16, crossAxisSpacing: 16, mainAxisExtent: 128),
                    delegate: SliverChildBuilderDelegate((_, i) => _LibraryCard(lib: value[i]), childCount: value.length),
                  ),
                ),
              AsyncError() => SliverFillRemaining(
                  hasScrollBody: false,
                  child: MessageState(
                    icon: 'wifi-off',
                    title: "Can't reach your server",
                    message: 'Pull to retry.',
                    actionLabel: 'Try again',
                    onAction: () => ref.invalidate(librariesProvider),
                  ),
                ),
              _ => SliverPadding(
                  padding: EdgeInsets.symmetric(horizontal: gutter),
                  sliver: SliverToBoxAdapter(
                    child: SkeletonScope(
                      child: Column(children: [for (var i = 0; i < 3; i++) const Padding(padding: EdgeInsets.only(bottom: 16), child: Skeleton(height: 128, radius: 26))]),
                    ),
                  ),
                ),
            },
            SliverPadding(padding: EdgeInsets.only(bottom: MediaQuery.paddingOf(context).bottom + 24)),
          ],
        ),
      ),
    );
  }
}

class _LibraryCard extends StatelessWidget {
  const _LibraryCard({required this.lib});
  final LibrarySummary lib;

  @override
  Widget build(BuildContext context) {
    final hue = hueFor(lib.id);
    final kinds = lib.contentProfile == 'ANIME' ? 'Anime' : lib.mediaKinds.map(kindLabel).map((k) => k == 'Series' ? 'TV' : '${k}s').join(' & ');
    return Pressable(
      onTap: () => context.push('/library/${lib.id}?name=${Uri.encodeComponent(lib.name)}'),
      semanticLabel: lib.name,
      builder: (context, focused) => AnimatedContainer(
        duration: const Duration(milliseconds: 200),
        padding: const EdgeInsets.all(5),
        decoration: BoxDecoration(color: HokagoColors.card, borderRadius: BorderRadius.circular(26), boxShadow: focused ? hokagoWiiRing : hokagoPanelShadow),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(21),
          child: DecoratedBox(
            decoration: BoxDecoration(gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: hue)),
            child: Stack(
              children: [
                const Positioned.fill(
                  child: Align(
                    alignment: Alignment.topCenter,
                    child: FractionallySizedBox(
                      heightFactor: 0.46,
                      widthFactor: 1,
                      child: DecoratedBox(
                        decoration: BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0x59FFFFFF), Color(0x00FFFFFF)])),
                      ),
                    ),
                  ),
                ),
                Positioned(right: -10, bottom: -18, child: HokagoIcon(_libraryIcon(lib), size: 120, color: Colors.white.withValues(alpha: 0.35))),
                Padding(
                  padding: const EdgeInsets.fromLTRB(22, 18, 22, 18),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      Text(lib.name, style: HokagoText.title.copyWith(fontSize: 26, color: Colors.white, shadows: const [Shadow(color: Color(0x40000000), blurRadius: 10)])),
                      if (kinds.toLowerCase() != lib.name.toLowerCase()) Text(kinds, style: HokagoText.meta.copyWith(color: Colors.white.withValues(alpha: 0.9), fontWeight: FontWeight.w700)),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// LibraryView.tsx: one library as a poster grid.
class LibraryScreen extends ConsumerWidget {
  const LibraryScreen({super.key, required this.libraryId, this.name});
  final String libraryId;
  final String? name;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final items = ref.watch(libraryItemsProvider(libraryId));
    final gutter = pageGutter(context);
    final top = MediaQuery.paddingOf(context).top;
    void refresh() => ref.invalidate(libraryItemsProvider(libraryId));
    return Scaffold(
      body: RefreshIndicator(
        onRefresh: () => ref.refresh(libraryItemsProvider(libraryId).future),
        child: CustomScrollView(
          physics: const AlwaysScrollableScrollPhysics(),
          slivers: [
            SliverPadding(
              padding: EdgeInsets.fromLTRB(gutter, top + 16, gutter, 20),
              sliver: SliverToBoxAdapter(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (context.canPop()) ...[WiiButton.ghost(compact: true, icon: 'back', label: 'Back', onPressed: () => context.pop()), const SizedBox(height: 16)],
                    PageHeader(name ?? 'Library', count: items.value?.length),
                  ],
                ),
              ),
            ),
            switch (items) {
              AsyncData(:final value) when value.isEmpty => const SliverFillRemaining(
                  hasScrollBody: false,
                  child: MessageState(icon: 'film', title: 'Nothing here yet', message: 'Files dropped into this library show up after the next scan.'),
                ),
              AsyncData(:final value) => SliverPadding(
                  padding: EdgeInsets.symmetric(horizontal: gutter),
                  sliver: posterGrid(
                    context,
                    items: value.map(cardToTile).toList(),
                    onOpen: (t) => context.push('/title/${t.id}'),
                    onLongPress: (t) => showTileActions(context, ref, t, onChanged: refresh),
                  ),
                ),
              AsyncError() => SliverFillRemaining(
                  hasScrollBody: false,
                  child: MessageState(icon: 'wifi-off', title: "Can't reach your server", message: 'Pull to retry.', actionLabel: 'Try again', onAction: refresh),
                ),
              _ => SliverPadding(
                  padding: EdgeInsets.symmetric(horizontal: gutter),
                  sliver: SliverToBoxAdapter(
                    child: SkeletonScope(
                      child: Wrap(
                        spacing: 14,
                        runSpacing: 24,
                        children: [for (var i = 0; i < 9; i++) const SizedBox(width: 108, child: Skeleton(radius: 20, aspectRatio: 2 / 3))],
                      ),
                    ),
                  ),
                ),
            },
            SliverPadding(padding: EdgeInsets.only(bottom: MediaQuery.paddingOf(context).bottom + 24)),
          ],
        ),
      ),
    );
  }
}
