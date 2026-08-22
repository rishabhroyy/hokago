import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/models/browse.dart';
import '../../core/session/session_controller.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/media_tile.dart';

/// Mirrors browse-api.ts's fetchSearchIndex: every top-level item across
/// every library, fetched once and filtered client-side (no server search
/// route — the whole catalog is small enough for this to be instant).
final searchIndexProvider = FutureProvider.autoDispose<List<MediaCard>>((ref) async {
  final api = ref.read(sessionProvider.notifier).api;
  final libs = await api.libraries();
  final lists = await Future.wait(libs.map((l) => api.libraryItems(l.id)));
  return lists.expand((l) => l).toList();
});

class SearchScreen extends ConsumerStatefulWidget {
  const SearchScreen({super.key});
  @override
  ConsumerState<SearchScreen> createState() => _SearchScreenState();
}

class _SearchScreenState extends ConsumerState<SearchScreen> {
  final _controller = TextEditingController();
  String _query = '';

  @override
  Widget build(BuildContext context) {
    final index = ref.watch(searchIndexProvider);
    return Scaffold(
      body: SafeArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
              child: TextField(
                controller: _controller,
                autofocus: true,
                textInputAction: TextInputAction.search,
                decoration: InputDecoration(
                  hintText: 'Search your library',
                  prefixIcon: Icon(Icons.search_rounded, color: HokagoColors.ink3),
                ),
                onChanged: (v) => setState(() => _query = v.trim().toLowerCase()),
              ),
            ),
            Expanded(
              child: index.when(
                loading: () => const Center(child: CircularProgressIndicator()),
                error: (e, _) => Center(child: Text('$e', style: HokagoText.meta)),
                data: (items) {
                  if (_query.isEmpty) {
                    return Center(child: Text('Search titles across every library', style: HokagoText.meta));
                  }
                  // Rank: prefix matches first, then containment.
                  final prefix = <MediaCard>[], rest = <MediaCard>[];
                  for (final item in items) {
                    final t = item.title.toLowerCase();
                    if (t.startsWith(_query)) {
                      prefix.add(item);
                    } else if (t.contains(_query)) {
                      rest.add(item);
                    }
                  }
                  final results = [...prefix, ...rest];
                  if (results.isEmpty) {
                    return Center(child: Text('No matches', style: HokagoText.meta));
                  }
                  return GridView.builder(
                    padding: const EdgeInsets.fromLTRB(16, 8, 16, 100),
                    gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                      maxCrossAxisExtent: 150,
                      mainAxisSpacing: 20,
                      crossAxisSpacing: 14,
                      childAspectRatio: 0.54,
                    ),
                    itemCount: results.length,
                    itemBuilder: (_, i) => MediaTile(item: results[i], onTap: () => context.push('/title/${results[i].id}')),
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}
