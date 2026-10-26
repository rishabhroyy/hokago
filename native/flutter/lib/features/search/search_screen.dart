import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/models/browse.dart';
import '../../core/session/session_controller.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/hokago_icon.dart';
import '../../core/widgets/media_tile.dart';
import '../../core/widgets/skeleton.dart';
import '../../core/widgets/wii_button.dart';
import '../common/states.dart';

/// browse-api.ts's fetchSearchIndex: every top-level item across every
/// library, fetched once and filtered client-side (no server search route).
final searchIndexProvider = FutureProvider.autoDispose<List<MediaCard>>((ref) async {
  final api = ref.read(sessionProvider.notifier).api;
  final libs = await api.libraries();
  final lists = await Future.wait(libs.map((l) => api.libraryItems(l.id)));
  return lists.expand((l) => l).toList();
});

/// SearchView.tsx's ranking: prefix matches first, then containment, both
/// in index order; case-insensitive.
List<MediaCard> rankSearch(List<MediaCard> index, String query) {
  final q = query.trim().toLowerCase();
  if (q.isEmpty) return const [];
  final prefix = <MediaCard>[], rest = <MediaCard>[];
  for (final item in index) {
    final t = item.title.toLowerCase();
    if (t.startsWith(q)) {
      prefix.add(item);
    } else if (t.contains(q)) {
      rest.add(item);
    }
  }
  return [...prefix, ...rest];
}

const _kindLabels = {'MOVIE': 'Movies', 'SERIES': 'Series', 'SEASON': 'Seasons', 'EPISODE': 'Episodes'};

class SearchScreen extends ConsumerStatefulWidget {
  const SearchScreen({super.key});
  @override
  ConsumerState<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends ConsumerState<SearchScreen> {
  final _controller = TextEditingController();
  String _query = '';
  String? _kind;
  // Browse mode: shuffled suggestions + picks, rolled once per index load.
  List<MediaCard>? _shuffledFor;
  List<MediaCard> _shuffled = const [];

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _setQuery(String v) => setState(() => _query = v);

  @override
  Widget build(BuildContext context) {
    final index = ref.watch(searchIndexProvider);
    final gutter = pageGutter(context);
    final top = MediaQuery.paddingOf(context).top;
    void open(TileItem t) => context.push('/title/${t.id}');

    final items = index.value;
    if (items != null && !identical(items, _shuffledFor)) {
      _shuffledFor = items;
      _shuffled = [...items]..shuffle();
    }
    final kinds = items == null ? const <String>[] : _kindLabels.keys.where((k) => items.any((i) => i.kind == k)).toList();
    final matches = items == null ? const <MediaCard>[] : rankSearch(items, _query);
    final results = _kind == null ? matches : matches.where((i) => i.kind == _kind).toList();
    final searching = _query.trim().isNotEmpty;

    return Scaffold(
      body: GestureDetector(
        onTap: () => FocusScope.of(context).unfocus(),
        behavior: HitTestBehavior.translucent,
        child: CustomScrollView(
          keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
          slivers: [
            SliverPadding(
              padding: EdgeInsets.fromLTRB(gutter, top + 20, gutter, 24),
              sliver: SliverToBoxAdapter(
                child: TextField(
                  controller: _controller,
                  textInputAction: TextInputAction.search,
                  style: HokagoText.cardTitle.copyWith(fontSize: 15.5),
                  decoration: InputDecoration(
                    hintText: 'Search movies and series',
                    contentPadding: const EdgeInsets.symmetric(vertical: 18),
                    prefixIcon: const Padding(padding: EdgeInsets.only(left: 18, right: 10), child: HokagoIcon('search', size: 20, color: HokagoColors.ink3)),
                    prefixIconConstraints: const BoxConstraints(),
                    suffixIcon: _query.isEmpty
                        ? null
                        : IconButton(
                            tooltip: 'Clear search',
                            icon: const HokagoIcon('x', size: 16, color: HokagoColors.ink3),
                            onPressed: () {
                              _controller.clear();
                              _setQuery('');
                            },
                          ),
                  ),
                  onChanged: _setQuery,
                  onSubmitted: (_) {
                    if (results.isNotEmpty) context.push('/title/${results.first.id}');
                  },
                ),
              ),
            ),
            if (index.hasError && items == null)
              SliverFillRemaining(
                hasScrollBody: false,
                child: MessageState(
                  icon: 'wifi-off',
                  title: "Can't reach your server",
                  message: 'Search needs the server. Your downloads still play offline.',
                  actionLabel: 'Try again',
                  onAction: () => ref.invalidate(searchIndexProvider),
                ),
              )
            else if (items == null)
              SliverPadding(padding: EdgeInsets.symmetric(horizontal: gutter), sliver: const SliverToBoxAdapter(child: _GridSkeleton()))
            else if (searching) ...[
              SliverPadding(
                padding: EdgeInsets.fromLTRB(gutter, 0, gutter, 16),
                sliver: SliverToBoxAdapter(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      PageHeader('Results', count: results.length),
                      if (kinds.length > 1) ...[
                        const SizedBox(height: 14),
                        Wrap(spacing: 8, runSpacing: 8, children: [
                          WiiChip(label: 'All', selected: _kind == null, onTap: () => setState(() => _kind = null)),
                          for (final k in kinds) WiiChip(label: _kindLabels[k]!, selected: _kind == k, onTap: () => setState(() => _kind = _kind == k ? null : k)),
                        ]),
                      ],
                    ],
                  ),
                ),
              ),
              if (results.isEmpty)
                SliverToBoxAdapter(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 56, horizontal: 24),
                    child: Column(children: [
                      const HokagoIcon('sparkle', size: 40, color: Color(0xA6EDB866)),
                      const SizedBox(height: 14),
                      const Text('No matches', style: HokagoText.section),
                      const SizedBox(height: 4),
                      Text('Nothing matches “${_query.trim()}”. Try another title.', style: HokagoText.body, textAlign: TextAlign.center),
                    ]),
                  ),
                )
              else
                SliverPadding(padding: EdgeInsets.symmetric(horizontal: gutter), sliver: posterGrid(context, items: results.map(cardToTile).toList(), onOpen: open)),
            ] else if (items.isEmpty)
              const SliverFillRemaining(
                hasScrollBody: false,
                child: MessageState(icon: 'search', title: 'Nothing on the shelves yet', message: 'Add a library from the admin panel and titles show up here.'),
              )
            else ...[
              SliverPadding(
                padding: EdgeInsets.fromLTRB(gutter, 0, gutter, 28),
                sliver: SliverToBoxAdapter(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('Try searching', style: HokagoText.section),
                      const SizedBox(height: 14),
                      Wrap(spacing: 8, runSpacing: 8, children: [
                        for (final item in _shuffled.where((i) => i.title.length <= 26).take(10))
                          WiiChip(
                            label: item.title,
                            onTap: () {
                              _controller.text = item.title;
                              _setQuery(item.title);
                            },
                          ),
                      ]),
                    ],
                  ),
                ),
              ),
              SliverPadding(padding: EdgeInsets.fromLTRB(gutter, 0, gutter, 16), sliver: const SliverToBoxAdapter(child: Text('You might like', style: HokagoText.section))),
              SliverPadding(padding: EdgeInsets.symmetric(horizontal: gutter), sliver: posterGrid(context, items: _shuffled.reversed.take(12).map(cardToTile).toList(), onOpen: open)),
            ],
            SliverPadding(padding: EdgeInsets.only(bottom: MediaQuery.paddingOf(context).bottom + 24)),
          ],
        ),
      ),
    );
  }
}

class _GridSkeleton extends StatelessWidget {
  const _GridSkeleton();
  @override
  Widget build(BuildContext context) => SkeletonScope(
        child: Wrap(
          spacing: 14,
          runSpacing: 24,
          children: [for (var i = 0; i < 6; i++) const SizedBox(width: 108, child: Skeleton(radius: 20, aspectRatio: 2 / 3))],
        ),
      );
}
