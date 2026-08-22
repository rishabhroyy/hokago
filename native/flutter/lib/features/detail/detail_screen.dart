import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/models/browse.dart';
import '../../core/api/token_store.dart';
import '../../core/downloads/download_providers.dart';
import '../../core/session/session_controller.dart';
import '../../core/text/strip_html.dart';
import '../../core/theme/app_theme.dart';
import '../../core/theme/hue.dart';
import '../../core/widgets/auth_image.dart';
import '../../core/widgets/ghost_button.dart';
import '../../core/widgets/wii_button.dart';
import '../downloads/downloads_screen.dart';

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

  Future<void> _download(BuildContext context, WidgetRef ref, MediaItemDetail item, {EpisodeCard? episode}) async {
    final mediaFileId = episode?.mediaFileId ?? item.mediaFileId;
    if (mediaFileId == null) return;
    final deviceId = await TokenStore.instance.deviceId;
    if (deviceId == null) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('This install has no registered device yet')));
      }
      return;
    }
    final messenger = ScaffoldMessenger.of(context);
    messenger.showSnackBar(SnackBar(content: Text('Downloading ${episode?.title ?? item.title}…')));
    try {
      await ref.read(downloadManagerProvider).downloadItem(
            mediaItemId: episode?.id ?? item.id,
            mediaFileId: mediaFileId,
            deviceId: deviceId,
            title: item.title,
            kind: episode != null ? 'EPISODE' : item.kind,
            subtitle: episode?.episodeNumber != null ? 'Episode ${episode!.episodeNumber}' : null,
            posterUrl: item.posterUrl,
            durationMs: episode?.runtimeMs,
          );
      ref.invalidate(offlineEntriesProvider);
      messenger.showSnackBar(const SnackBar(content: Text('Saved for offline playback')));
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('Download failed: $e')));
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final detail = ref.watch(detailProvider(itemId));
    return Scaffold(
      body: detail.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('$e', style: TextStyle(color: HokagoColors.ink2))),
        data: (item) => _DetailContent(
          item: item,
          onPlay: (ep) => _play(context, item, episode: ep),
          onDownload: (ep) => _download(context, ref, item, episode: ep),
        ),
      ),
    );
  }
}

class _DetailContent extends StatelessWidget {
  const _DetailContent({required this.item, required this.onPlay, required this.onDownload});
  final MediaItemDetail item;
  final void Function(EpisodeCard?) onPlay;
  final void Function(EpisodeCard?) onDownload;

  @override
  Widget build(BuildContext context) {
    final isSeries = item.kind == 'SERIES';
    final resumeMs = item.watch?.positionMs ?? 0;
    // The hero action targets the next thing to watch: an in-progress episode,
    // else the first unwatched one, else the first (rewatch), same as
    // DetailView.tsx's nextEpisode logic.
    EpisodeCard? nextEpisode;
    if (isSeries) {
      nextEpisode = item.episodes.cast<EpisodeCard?>().firstWhere((e) => e != null && !e.watched && e.positionMs > 0, orElse: () => null) ??
          item.episodes.cast<EpisodeCard?>().firstWhere((e) => e != null && !e.watched, orElse: () => null) ??
          (item.episodes.isNotEmpty ? item.episodes.first : (item.movies.isNotEmpty ? item.movies.first : null));
    }
    final hue = hueFor(item.id);

    final topInset = MediaQuery.paddingOf(context).top;

    return CustomScrollView(
      slivers: [
        // Banner + overlapping sheet panel share one sliver (a Column, not
        // two separate ones) — Transform-overlapping content across a
        // sliver boundary risks the wrong paint order; within one Column
        // Flutter's normal "later child paints on top" rule is unambiguous.
        SliverToBoxAdapter(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Stack(
                clipBehavior: Clip.none,
                children: [
                  // Banner — backdrop art, or a blurred poster, or the hue fallback.
                  SizedBox(
                    height: 260,
                    width: double.infinity,
                    child: DecoratedBox(
                      decoration: BoxDecoration(gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: hue)),
                      child: Stack(
                        fit: StackFit.expand,
                        children: [
                          if (item.backdropUrl != null || item.posterUrl != null) AuthImage(url: item.backdropUrl ?? item.posterUrl),
                          DecoratedBox(
                            decoration: BoxDecoration(
                              gradient: LinearGradient(
                                begin: Alignment.topCenter,
                                end: Alignment.bottomCenter,
                                colors: [Colors.transparent, HokagoColors.bg],
                                stops: const [0.3, 1.0],
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  Positioned(
                    top: topInset + 8,
                    left: 16,
                    child: GhostButton(icon: Icons.arrow_back_rounded, onPressed: () => context.pop(), child: const Text('Back')),
                  ),
                ],
              ),
              Transform.translate(
                offset: const Offset(0, -70),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: DecoratedBox(
                    decoration: BoxDecoration(color: HokagoColors.paper, borderRadius: BorderRadius.circular(26), boxShadow: hokagoPanelShadow),
                    child: Padding(
                      padding: const EdgeInsets.all(20),
                      child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      // The tilted "channel-framed" poster, sticking up over the banner.
                      Transform.translate(
                        offset: const Offset(0, -46),
                        child: Transform.rotate(
                          angle: -0.035,
                          child: DecoratedBox(
                            decoration: BoxDecoration(color: HokagoColors.card, borderRadius: BorderRadius.circular(20), boxShadow: hokagoPanelShadow),
                            child: Padding(
                              padding: const EdgeInsets.all(5),
                              child: SizedBox(
                                width: 108,
                                child: AspectRatio(
                                  aspectRatio: 2 / 3,
                                  child: ClipRRect(
                                    borderRadius: BorderRadius.circular(15),
                                    child: item.posterUrl != null
                                        ? AuthImage(url: item.posterUrl)
                                        : DecoratedBox(
                                            decoration: BoxDecoration(gradient: LinearGradient(colors: hue)),
                                            child: const Icon(Icons.movie_creation_rounded, color: Colors.white, size: 32),
                                          ),
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(width: 14),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(item.title, style: HokagoText.titleXl.copyWith(fontSize: 24)),
                            const SizedBox(height: 8),
                            Wrap(
                              spacing: 6,
                              runSpacing: 6,
                              children: [
                                _MetaChip(isSeries ? 'Series' : 'Movie'),
                                if (item.year != null) _MetaChip('${item.year}'),
                                if (item.rating != null) _MetaChip('★ ${item.rating!.toStringAsFixed(1)}'),
                                if (isSeries && item.episodes.isNotEmpty) _MetaChip('${item.episodes.length} episodes'),
                              ],
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
            ],
          ),
        ),
        SliverToBoxAdapter(
          child: Transform.translate(
            offset: const Offset(0, -60),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (item.genres.isNotEmpty)
                    Wrap(
                      spacing: 8,
                      runSpacing: 8,
                      children: [for (final g in item.genres.take(6)) _GenreChip(g)],
                    ),
                  if (item.genres.isNotEmpty) const SizedBox(height: 16),
                  Row(
                    children: [
                      if (nextEpisode != null || !isSeries)
                        WiiButton(
                          icon: Icons.play_arrow_rounded,
                          onPressed: () => onPlay(isSeries ? nextEpisode : null),
                          child: Text(resumeMs > 0 ? 'Resume' : 'Play'),
                        ),
                      const SizedBox(width: 10),
                      GhostButton(
                        icon: Icons.download_outlined,
                        onPressed: () => onDownload(isSeries ? nextEpisode : null),
                        child: const Text('Download'),
                      ),
                    ],
                  ),
                  if (item.overview != null) ...[
                    const SizedBox(height: 18),
                    Text(stripHtml(item.overview!), style: HokagoText.body),
                  ],
                ],
              ),
            ),
          ),
        ),
        if (item.episodes.isNotEmpty)
          SliverPadding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            sliver: SliverGrid(
              gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(maxCrossAxisExtent: 230, mainAxisSpacing: 20, crossAxisSpacing: 16, childAspectRatio: 1.35),
              delegate: SliverChildBuilderDelegate(
                (_, i) => EpisodeTile(episode: item.episodes[i], onTap: () => onPlay(item.episodes[i])),
                childCount: item.episodes.length,
              ),
            ),
          ),
        if (item.movies.isNotEmpty)
          SliverToBoxAdapter(
            child: Padding(padding: const EdgeInsets.fromLTRB(16, 20, 16, 8), child: Text('Movies', style: HokagoText.section)),
          ),
        if (item.movies.isNotEmpty)
          SliverPadding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            sliver: SliverGrid(
              gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(maxCrossAxisExtent: 230, mainAxisSpacing: 20, crossAxisSpacing: 16, childAspectRatio: 1.35),
              delegate: SliverChildBuilderDelegate(
                (_, i) => EpisodeTile(episode: item.movies[i], onTap: () => onPlay(item.movies[i])),
                childCount: item.movies.length,
              ),
            ),
          ),
        const SliverToBoxAdapter(child: SizedBox(height: 32)),
      ],
    );
  }
}

class _MetaChip extends StatelessWidget {
  const _MetaChip(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        decoration: BoxDecoration(color: HokagoColors.paper2, borderRadius: BorderRadius.circular(HokagoRadii.pill), border: Border.all(color: HokagoColors.line)),
        child: Text(text, style: TextStyle(fontFamily: 'Plus Jakarta Sans', fontSize: 12.5, fontWeight: FontWeight.w600, color: HokagoColors.ink2)),
      );
}

class _GenreChip extends StatelessWidget {
  const _GenreChip(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(
          color: HokagoColors.wiiDeep.withValues(alpha: 0.08),
          borderRadius: BorderRadius.circular(HokagoRadii.pill),
          border: Border.all(color: HokagoColors.wiiDeep.withValues(alpha: 0.15)),
        ),
        child: Text(text, style: TextStyle(fontFamily: 'Plus Jakarta Sans', fontSize: 12.5, fontWeight: FontWeight.w700, color: HokagoColors.wiiDeep)),
      );
}

/// ui/DetailView.tsx's episode grid card: framed landscape thumbnail (kicker
/// EP badge, watched checkmark, runtime pill, resume progress bar) + bold
/// title below — not a ListTile.
class EpisodeTile extends StatelessWidget {
  const EpisodeTile({super.key, required this.episode, required this.onTap});
  final EpisodeCard episode;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final progress = !episode.watched && episode.runtimeMs != null && episode.runtimeMs! > 0 ? episode.positionMs / episode.runtimeMs! : 0.0;
    final hue = hueFor(episode.id);
    return GestureDetector(
      onTap: onTap,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: DecoratedBox(
              decoration: BoxDecoration(color: HokagoColors.card, borderRadius: BorderRadius.circular(18), boxShadow: hokagoPanelShadow),
              child: Padding(
                padding: const EdgeInsets.all(5),
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(13),
                  child: Stack(
                    fit: StackFit.expand,
                    children: [
                      episode.posterUrl != null || episode.backdropUrl != null
                          ? Opacity(
                              opacity: episode.watched ? 0.6 : 1,
                              child: AuthImage(url: episode.posterUrl ?? episode.backdropUrl),
                            )
                          : DecoratedBox(decoration: BoxDecoration(gradient: LinearGradient(colors: hue))),
                      Positioned(
                        left: 8,
                        top: 8,
                        child: _Badge(episode.kind == 'MOVIE' ? 'MOVIE' : 'EP ${episode.episodeNumber ?? '?'}', bg: Colors.white, fg: HokagoColors.ink),
                      ),
                      if (episode.watched)
                        Positioned(
                          right: 8,
                          top: 8,
                          child: Container(
                            width: 22,
                            height: 22,
                            decoration: BoxDecoration(color: HokagoColors.wiiDeep, shape: BoxShape.circle),
                            child: const Icon(Icons.check_rounded, color: Colors.white, size: 14),
                          ),
                        ),
                      if (episode.runtimeMs != null)
                        Positioned(
                          right: 8,
                          bottom: progress > 0 ? 12 : 8,
                          child: _Badge('${(episode.runtimeMs! / 60000).round()}m', bg: Colors.black.withValues(alpha: 0.55), fg: Colors.white),
                        ),
                      if (progress > 0)
                        Positioned(
                          left: 0,
                          right: 0,
                          bottom: 0,
                          child: SizedBox(
                            height: 4,
                            child: LinearProgressIndicator(value: progress.clamp(0.0, 1.0), backgroundColor: Colors.black38, color: HokagoColors.wii),
                          ),
                        ),
                    ],
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(height: 8),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 2),
            child: Text(
              episode.episodeNumber != null ? '${episode.episodeNumber}. ${episode.title}' : episode.title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: HokagoText.cardTitle.copyWith(color: episode.watched ? HokagoColors.ink3 : HokagoColors.ink),
            ),
          ),
        ],
      ),
    );
  }
}

class _Badge extends StatelessWidget {
  const _Badge(this.text, {required this.bg, required this.fg});
  final String text;
  final Color bg, fg;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(HokagoRadii.pill)),
        child: Text(text, style: HokagoText.kicker.copyWith(color: fg, fontSize: 9.5)),
      );
}
