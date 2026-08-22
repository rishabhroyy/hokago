import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/models/browse.dart';
import '../../core/session/session_controller.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/auth_image.dart';

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
      appBar: AppBar(
        title: TextField(
          controller: _controller,
          autofocus: false,
          decoration: const InputDecoration(hintText: 'Search your library', border: InputBorder.none),
          onChanged: (v) => setState(() => _query = v.trim().toLowerCase()),
        ),
      ),
      body: index.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('$e', style: const TextStyle(color: HokagoColors.ink2))),
        data: (items) {
          final results = _query.isEmpty ? const <MediaCard>[] : items.where((i) => i.title.toLowerCase().contains(_query)).toList();
          if (_query.isEmpty) {
            return const Center(child: Text('Search titles across every library', style: TextStyle(color: HokagoColors.ink3)));
          }
          if (results.isEmpty) {
            return const Center(child: Text('No matches', style: TextStyle(color: HokagoColors.ink3)));
          }
          return ListView.builder(
            itemCount: results.length,
            itemBuilder: (_, i) {
              final item = results[i];
              return ListTile(
                leading: SizedBox(width: 44, height: 66, child: AuthImage(url: item.posterUrl, borderRadius: BorderRadius.circular(6))),
                title: Text(item.title, style: const TextStyle(color: HokagoColors.ink)),
                subtitle: item.year != null ? Text('${item.year}', style: const TextStyle(color: HokagoColors.ink3)) : null,
                onTap: () => context.push('/title/${item.id}'),
              );
            },
          );
        },
      ),
    );
  }
}
