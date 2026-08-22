import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/models/browse.dart';
import '../../core/session/session_controller.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/auth_image.dart';

final detailProvider = FutureProvider.autoDispose.family<MediaItemDetail, String>((ref, itemId) {
  final session = ref.watch(sessionProvider);
  return ref.read(sessionProvider.notifier).api.mediaItemDetail(itemId, profileId: session.profileId);
});

class DetailScreen extends ConsumerWidget {
  const DetailScreen({super.key, required this.itemId});
  final String itemId;

  void _play(BuildContext context, MediaItemDetail item, {EpisodeCard? episode}) {
    final mediaFileId = episode?.mediaFileId ?? item.mediaFileId;
    if (mediaFileId == null) return;
    final mediaItemId = episode?.id ?? item.id;
    context.push('/watch/$mediaFileId?mediaItemId=$mediaItemId');
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final detail = ref.watch(detailProvider(itemId));
    return Scaffold(
      body: detail.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('$e', style: const TextStyle(color: HokagoColors.ink2))),
        data: (item) => _DetailContent(item: item, onPlay: (ep) => _play(context, item, episode: ep)),
      ),
    );
  }
}

class _DetailContent extends StatelessWidget {
  const _DetailContent({required this.item, required this.onPlay});
  final MediaItemDetail item;
  final void Function(EpisodeCard?) onPlay;

  @override
  Widget build(BuildContext context) {
    final isSeries = item.kind == 'SERIES';
    final canPlayDirectly = !isSeries && item.mediaFileId != null;
    final resumeMs = item.watch?.positionMs ?? 0;

    return CustomScrollView(
      slivers: [
        SliverAppBar(
          expandedHeight: 260,
          pinned: true,
          backgroundColor: HokagoColors.bg,
          flexibleSpace: FlexibleSpaceBar(
            background: Stack(
              fit: StackFit.expand,
              children: [
                AuthImage(url: item.backdropUrl ?? item.posterUrl),
                DecoratedBox(
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.topCenter,
                      end: Alignment.bottomCenter,
                      colors: [Colors.transparent, HokagoColors.bg],
                      stops: const [0.35, 1.0],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
        SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(item.title, style: const TextStyle(fontSize: 26, fontWeight: FontWeight.w800, color: HokagoColors.ink)),
                const SizedBox(height: 6),
                Wrap(
                  spacing: 10,
                  children: [
                    if (item.year != null) _Meta('${item.year}'),
                    if (item.rating != null) _Meta('★ ${item.rating!.toStringAsFixed(1)}'),
                    _Meta(item.kind),
                    for (final g in item.genres.take(3)) _Meta(g),
                  ],
                ),
                if (canPlayDirectly) ...[
                  const SizedBox(height: 18),
                  ElevatedButton.icon(
                    onPressed: () => onPlay(null),
                    icon: const Icon(Icons.play_arrow_rounded),
                    label: Text(resumeMs > 0 ? 'Resume' : 'Play'),
                  ),
                ],
                if (item.overview != null) ...[
                  const SizedBox(height: 18),
                  Text(item.overview!, style: const TextStyle(color: HokagoColors.ink2, height: 1.5, fontSize: 14)),
                ],
              ],
            ),
          ),
        ),
        if (item.episodes.isNotEmpty)
          SliverList.builder(
            itemCount: item.episodes.length,
            itemBuilder: (_, i) => _EpisodeRow(episode: item.episodes[i], onTap: () => onPlay(item.episodes[i])),
          ),
        if (item.movies.isNotEmpty)
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
              child: Text('Movies', style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700, color: HokagoColors.ink)),
            ),
          ),
        if (item.movies.isNotEmpty)
          SliverList.builder(
            itemCount: item.movies.length,
            itemBuilder: (_, i) => _EpisodeRow(episode: item.movies[i], onTap: () => onPlay(item.movies[i])),
          ),
        const SliverToBoxAdapter(child: SizedBox(height: 32)),
      ],
    );
  }
}

class _Meta extends StatelessWidget {
  const _Meta(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Text(text, style: const TextStyle(color: HokagoColors.ink3, fontSize: 13));
}

class _EpisodeRow extends StatelessWidget {
  const _EpisodeRow({required this.episode, required this.onTap});
  final EpisodeCard episode;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final progress = episode.runtimeMs != null && episode.runtimeMs! > 0 ? episode.positionMs / episode.runtimeMs! : 0.0;
    return ListTile(
      onTap: onTap,
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
      leading: SizedBox(
        width: 120,
        height: 68,
        child: Stack(
          children: [
            Positioned.fill(child: AuthImage(url: episode.posterUrl ?? episode.backdropUrl, borderRadius: BorderRadius.circular(10))),
            if (episode.watched)
              const Positioned(right: 4, top: 4, child: Icon(Icons.check_circle_rounded, color: HokagoColors.wii, size: 18)),
            if (progress > 0 && progress < 0.95)
              Positioned(
                left: 6,
                right: 6,
                bottom: 5,
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(2),
                  child: LinearProgressIndicator(value: progress, minHeight: 3, backgroundColor: Colors.black45, color: HokagoColors.accent),
                ),
              ),
          ],
        ),
      ),
      title: Text(
        episode.episodeNumber != null ? '${episode.episodeNumber}. ${episode.title}' : episode.title,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600, color: HokagoColors.ink),
      ),
      trailing: const Icon(Icons.play_arrow_rounded, color: HokagoColors.ink3),
    );
  }
}
