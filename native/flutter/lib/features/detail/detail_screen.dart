import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/models/browse.dart';
import '../../core/api/token_store.dart';
import '../../core/downloads/download_providers.dart';
import '../../core/platform.dart';
import '../../core/session/session_controller.dart';
import '../../core/text/strip_html.dart';
import '../../core/theme/app_theme.dart';
import '../../core/theme/hue.dart';
import '../../core/widgets/auth_image.dart';
import '../../core/widgets/hokago_icon.dart';
import '../../core/widgets/media_tile.dart';
import '../../core/widgets/pressable.dart';
import '../../core/widgets/skeleton.dart';
import '../../core/widgets/wii_button.dart';
import '../common/states.dart';
import '../common/tile_actions.dart';
import '../downloads/downloads_screen.dart';
import 'fix_match_sheet.dart';

final detailProvider = FutureProvider.autoDispose.family<MediaItemDetail, String>((ref, itemId) {
  final profileId = ref.watch(sessionProvider.select((s) => s.profileId));
  return ref.read(sessionProvider.notifier).api.mediaItemDetail(itemId, profileId: profileId);
});

/// DetailView.tsx's nextEpisode: the in-progress episode, else the first
/// unwatched one, else the first (a rewatch), else the first movie.
EpisodeCard? nextEpisodeOf(MediaItemDetail item) {
  final eps = item.episodes;
  for (final e in eps) {
    if (!e.watched && e.positionMs > 0) return e;
  }
  for (final e in eps) {
    if (!e.watched) return e;
  }
  if (eps.isNotEmpty) return eps.first;
  return item.movies.isNotEmpty ? item.movies.first : null;
}

/// The episode after [currentId] in the series' own order (episodes, then
/// show-scoped movies) — the player's up-next pick. Null at the end.
EpisodeCard? nextEpisodeAfter(MediaItemDetail series, String currentId) {
  final all = [...series.episodes, ...series.movies];
  final i = all.indexWhere((e) => e.id == currentId);
  if (i < 0) return null;
  for (final e in all.skip(i + 1)) {
    if (e.mediaFileId != null) return e;
  }
  return null;
}

String _seasonLabel(int? n) => n == null ? 'Episodes' : (n == 0 ? 'Specials' : 'Season $n');

class DetailScreen extends ConsumerStatefulWidget {
  const DetailScreen({super.key, required this.itemId});
  final String itemId;
  @override
  ConsumerState<DetailScreen> createState() => _DetailScreenState();
}

class _DetailScreenState extends ConsumerState<DetailScreen> {
  /// Only an explicit pick here overrides the player's remembered language.
  int? _audio;

  String? get _profileId => ref.read(sessionProvider).profileId;

  void _refresh() => ref.invalidate(detailProvider(widget.itemId));

  void _play(String? mediaFileId, String mediaItemId) {
    if (mediaFileId == null) return;
    final series = mediaItemId != widget.itemId ? '&series=${widget.itemId}' : '';
    final audio = _audio != null && mediaItemId == widget.itemId ? '&audio=$_audio' : '';
    context.push('/watch/$mediaFileId?mediaItemId=$mediaItemId$series$audio');
  }

  Future<void> _startParty(String? mediaFileId, String mediaItemId) async {
    final profileId = _profileId;
    if (profileId == null || mediaFileId == null) return;
    try {
      final party = await ref.read(sessionProvider.notifier).api.createParty(profileId: profileId, mediaItemId: mediaItemId);
      if (!mounted) return;
      context.push('/watch/${party.mediaFileId ?? mediaFileId}?mediaItemId=${party.mediaItemId}&party=${party.id}');
    } catch (_) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("Couldn't start a watch party")));
    }
  }

  Future<void> _download(MediaItemDetail item, {EpisodeCard? episode}) async {
    final mediaFileId = episode?.mediaFileId ?? item.mediaFileId ?? nextEpisodeOf(item)?.mediaFileId;
    final target = episode ?? (item.kind == 'SERIES' ? nextEpisodeOf(item) : null);
    if (mediaFileId == null) return;
    final messenger = ScaffoldMessenger.of(context);
    final deviceId = await TokenStore.instance.deviceId;
    if (deviceId == null) {
      messenger.showSnackBar(const SnackBar(content: Text('Sign in again to enable downloads on this device')));
      return;
    }
    if (!mounted) return;
    final variant = await showModalBottomSheet<_DownloadVariant>(context: context, builder: (_) => const _DownloadVariantSheet());
    if (variant == null) return;
    messenger.showSnackBar(SnackBar(content: Text('Downloading ${target?.title ?? item.title}…')));
    try {
      await ref.read(downloadManagerProvider).downloadItem(
            mediaItemId: target?.id ?? item.id,
            mediaFileId: mediaFileId,
            deviceId: deviceId,
            title: item.title,
            kind: target != null ? (target.kind == 'MOVIE' ? 'MOVIE' : 'EPISODE') : item.kind,
            subtitle: target == null
                ? null
                : target.episodeNumber != null
                    ? 'S${target.seasonNumber ?? 1} E${target.episodeNumber} · ${target.title}'
                    : target.title,
            posterUrl: item.posterUrl,
            durationMs: target?.runtimeMs,
            maxHeight: variant.maxHeight,
            maxBitrateKbps: variant.maxBitrateKbps,
          );
      ref.invalidate(offlineEntriesProvider);
      messenger.showSnackBar(const SnackBar(content: Text('Saved for offline playback')));
    } catch (_) {
      messenger.showSnackBar(const SnackBar(content: Text("Download didn't finish — try again from the title page")));
    }
  }

  Future<void> _mark(List<String> ids, bool watched) async {
    final profileId = _profileId;
    if (profileId == null || ids.isEmpty) return;
    final api = ref.read(sessionProvider.notifier).api;
    try {
      await Future.wait(ids.map((id) => api.setWatched(id, profileId: profileId, watched: watched)));
      _refresh();
    } catch (_) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("Couldn't update watch state")));
    }
  }

  void _episodeMenu(MediaItemDetail item, EpisodeCard ep) {
    showActionSheet(
      context,
      title: ep.title,
      subtitle: ep.episodeNumber != null ? 'S${ep.seasonNumber ?? 1} E${ep.episodeNumber}' : kindLabel(ep.kind),
      actions: [
        if (ep.mediaFileId != null) SheetAction('Play', 'play', () => _play(ep.mediaFileId, ep.id)),
        if (ep.mediaFileId != null) SheetAction('Watch party', 'users', () => _startParty(ep.mediaFileId, ep.id)),
        if (ep.mediaFileId != null && !isTvBuild) SheetAction('Download', 'download', () => _download(item, episode: ep)),
        ep.watched ? SheetAction('Unwatch', 'refresh', () => _mark([ep.id], false)) : SheetAction('Mark as watched', 'check', () => _mark([ep.id], true)),
      ],
    );
  }

  void _titleMenu(MediaItemDetail item) {
    final ids = item.kind == 'MOVIE' ? [item.id] : [...item.episodes.map((e) => e.id), ...item.movies.map((e) => e.id)];
    showActionSheet(
      context,
      title: item.title,
      actions: [
        SheetAction(item.kind == 'MOVIE' ? 'Mark as watched' : 'Mark title watched', 'check', () => _mark(ids, true)),
        SheetAction(item.kind == 'MOVIE' ? 'Unwatch' : 'Unwatch title', 'refresh', () => _mark(ids, false)),
        if (item.kind == 'MOVIE' || item.kind == 'SERIES') SheetAction('Fix match', 'search', () => showFixMatchSheet(context, item: item, onPinned: _refresh)),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final detail = ref.watch(detailProvider(widget.itemId));
    return Scaffold(
      body: switch (detail) {
        AsyncData(:final value) => _content(value),
        AsyncError() when !detail.isLoading => Stack(children: [
            MessageState(icon: 'wifi-off', title: "Can't load this title", message: 'Check your connection and try again.', actionLabel: 'Try again', onAction: _refresh),
            _BackButton(onTap: () => context.pop()),
          ]),
        _ => _DetailSkeleton(itemId: widget.itemId),
      },
    );
  }

  Widget _content(MediaItemDetail item) {
    final wide = isWide(context);
    final isSeries = item.kind == 'SERIES';
    final next = isSeries ? nextEpisodeOf(item) : null;
    final isContinue = next != null && !next.watched && next.positionMs > 0;
    final playFileId = isSeries ? next?.mediaFileId : item.mediaFileId;
    final playItemId = isSeries ? next?.id : item.id;
    final playLabel = isSeries
        ? '${isContinue ? 'Continue' : 'Play'}${next?.kind == 'MOVIE' ? '' : ' S${next?.seasonNumber ?? 1} E${next?.episodeNumber ?? 1}'}'
        : (item.watch != null && item.watch!.positionMs > 0 && !item.watch!.watched ? 'Resume' : 'Play');
    final watchedCount = item.episodes.where((e) => e.watched).length;

    final seasons = <int?, List<EpisodeCard>>{};
    for (final ep in item.episodes) {
      (seasons[ep.seasonNumber] ??= []).add(ep);
    }

    final meta = [
      if (item.year != null) '${item.year}',
      isSeries && item.episodes.isNotEmpty ? 'Series, ${item.episodes.length} episodes' : kindLabel(item.kind),
      if (item.genres.isNotEmpty) item.genres.take(3).join(', '),
    ];
    final small = <InlineSpan>[
      if (isSeries && watchedCount > 0) TextSpan(text: '$watchedCount of ${item.episodes.length} watched'),
      if ((item.watch?.playCount ?? 0) > 0) TextSpan(text: 'Watched ${item.watch!.playCount}×'),
      if (item.bitrateKbps != null && item.bitrateQuality != null)
        TextSpan(
          text: '${(item.bitrateKbps! / 1000).toStringAsFixed(1)} Mbps',
          style: TextStyle(color: switch (item.bitrateQuality) { 'poor' => const Color(0xFFF87171), 'ok' => const Color(0xFFFBBF24), _ => const Color(0xFF34D399) }),
        ),
      if (item.studio != null) TextSpan(text: item.studio),
    ];

    final poster = Transform.rotate(
      angle: -0.035,
      child: Container(
        width: wide ? 192 : 132,
        padding: const EdgeInsets.all(5),
        decoration: BoxDecoration(color: HokagoColors.card, borderRadius: BorderRadius.circular(26), boxShadow: hokagoPanelShadow),
        child: AspectRatio(aspectRatio: 2 / 3, child: ChannelArt(id: item.id, url: item.posterUrl, radius: 21, iconScale: 0.4)),
      ),
    );

    final info = Column(
      crossAxisAlignment: wide ? CrossAxisAlignment.start : CrossAxisAlignment.center,
      children: [
        GestureDetector(
          onLongPress: () => _titleMenu(item),
          child: Text(item.title, textAlign: wide ? TextAlign.start : TextAlign.center, style: HokagoText.titleXl.copyWith(fontSize: wide ? 40 : 30)),
        ),
        if (item.originalTitle != null && item.originalTitle != item.title)
          Padding(padding: const EdgeInsets.only(top: 6), child: Text(item.originalTitle!, style: HokagoText.body.copyWith(color: HokagoColors.ink3))),
        const SizedBox(height: 12),
        Wrap(
          alignment: wide ? WrapAlignment.start : WrapAlignment.center,
          crossAxisAlignment: WrapCrossAlignment.center,
          spacing: 14,
          runSpacing: 4,
          children: [
            for (final m in meta) Text(m, style: HokagoText.meta),
            if (item.rating != null)
              Row(mainAxisSize: MainAxisSize.min, children: [
                const HokagoIcon('star', size: 14, color: HokagoColors.gold),
                const SizedBox(width: 4),
                Text(item.rating!.toStringAsFixed(1), style: HokagoText.meta),
              ]),
          ],
        ),
        if (small.isNotEmpty) ...[
          const SizedBox(height: 6),
          Text.rich(
            TextSpan(children: [for (var i = 0; i < small.length; i++) ...[if (i > 0) const TextSpan(text: '   '), small[i]]]),
            textAlign: wide ? TextAlign.start : TextAlign.center,
            style: HokagoText.small,
          ),
        ],
        const SizedBox(height: 20),
        Wrap(
          alignment: wide ? WrapAlignment.start : WrapAlignment.center,
          spacing: 10,
          runSpacing: 10,
          children: [
            if (playFileId != null) WiiButton(icon: 'play', label: playLabel, autofocus: isTvBuild, onPressed: () => _play(playFileId, playItemId!)),
            if (playFileId != null) WiiButton.ghost(compact: !wide, icon: 'users', label: 'Watch party', onPressed: () => _startParty(playFileId, playItemId!)),
            if (playFileId != null && !isTvBuild) WiiButton.ghost(compact: !wide, icon: 'download', label: 'Download', onPressed: () => _download(item)),
            WiiButton.ghost(compact: !wide, icon: 'list', label: 'More', onPressed: () => _titleMenu(item)),
          ],
        ),
        if (item.audioTracks.length >= 2) ...[
          const SizedBox(height: 18),
          Wrap(
            alignment: wide ? WrapAlignment.start : WrapAlignment.center,
            crossAxisAlignment: WrapCrossAlignment.center,
            spacing: 8,
            runSpacing: 8,
            children: [
              const Padding(padding: EdgeInsets.only(right: 4), child: Text('Audio', style: HokagoText.small)),
              for (final t in item.audioTracks)
                WiiChip(label: t.lang?.toUpperCase() ?? 'Track ${t.streamIndex}', selected: (_audio ?? item.audioTracks.first.streamIndex) == t.streamIndex, onTap: () => setState(() => _audio = t.streamIndex)),
            ],
          ),
        ],
        if (item.overview != null) ...[
          const SizedBox(height: 20),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 680),
            child: Text(stripHtml(item.overview!), style: HokagoText.body, textAlign: wide ? TextAlign.start : TextAlign.left),
          ),
        ],
      ],
    );

    final bannerH = wide ? 420.0 : 320.0;
    return Stack(
      children: [
        CustomScrollView(
          slivers: [
            SliverToBoxAdapter(child: _Banner(item: item, height: bannerH)),
            SliverToBoxAdapter(
              child: Transform.translate(
                offset: const Offset(0, -96),
                child: Padding(
                  padding: EdgeInsets.symmetric(horizontal: wide ? 48 : 14),
                  child: _Sheet(
                    padding: EdgeInsets.all(wide ? 36 : 20),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        if (wide)
                          Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Transform.translate(offset: const Offset(0, -120), child: poster),
                            const SizedBox(width: 36),
                            Expanded(child: info),
                          ])
                        else ...[
                          Transform.translate(offset: const Offset(0, -64), child: Center(child: poster)),
                          Transform.translate(offset: const Offset(0, -48), child: info),
                        ],
                        if (!item.isDownloaded) const _NotDownloaded(),
                        for (final MapEntry(key: season, value: eps) in seasons.entries)
                          _SeasonGrid(
                            label: _seasonLabel(season),
                            episodes: eps,
                            onOpen: (ep) => _play(ep.mediaFileId, ep.id),
                            onMenu: (ep) => _episodeMenu(item, ep),
                          ),
                        if (item.movies.isNotEmpty)
                          _SeasonGrid(label: 'Movies', episodes: item.movies, onOpen: (ep) => _play(ep.mediaFileId, ep.id), onMenu: (ep) => _episodeMenu(item, ep)),
                      ],
                    ),
                  ),
                ),
              ),
            ),
            for (final c in item.collections)
              SliverToBoxAdapter(
                child: Transform.translate(
                  offset: const Offset(0, -72),
                  child: MediaRail(title: c.name, items: c.entries.map((e) => cardToTile(e.item)).toList(), onOpen: (t) => context.push('/title/${t.id}')),
                ),
              ),
            SliverPadding(padding: EdgeInsets.only(bottom: MediaQuery.paddingOf(context).bottom)),
          ],
        ),
        _BackButton(onTap: () => context.canPop() ? context.pop() : context.go('/')),
      ],
    );
  }
}

/// The `.panel` sheet: one glossy page holding everything about the title.
class _Sheet extends StatelessWidget {
  const _Sheet({required this.child, required this.padding});
  final Widget child;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) => Container(
        padding: padding,
        decoration: BoxDecoration(
          color: HokagoColors.panelFill,
          borderRadius: BorderRadius.circular(30),
          border: Border.all(color: HokagoColors.panelBorder),
          boxShadow: hokagoPanelShadow,
        ),
        child: child,
      );
}

class _BackButton extends StatelessWidget {
  const _BackButton({required this.onTap});
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Positioned(
        top: MediaQuery.paddingOf(context).top + 10,
        left: pageGutter(context) - 4,
        child: GlassIconButton(icon: 'back', semanticLabel: 'Back', onPressed: onTap),
      );
}

class _Banner extends StatelessWidget {
  const _Banner({required this.item, required this.height});
  final MediaItemDetail item;
  final double height;

  @override
  Widget build(BuildContext context) {
    final backdrop = item.backdropUrl;
    return SizedBox(
      height: height,
      child: ShaderMask(
        blendMode: BlendMode.dstIn,
        shaderCallback: (r) => const LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [Colors.black, Colors.black, Colors.transparent],
          stops: [0, 0.55, 1],
        ).createShader(r),
        child: Stack(
          fit: StackFit.expand,
          children: [
            DecoratedBox(decoration: BoxDecoration(gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: hueFor(item.id)))),
            if (backdrop != null)
              AuthImage(url: backdrop)
            else if (item.posterUrl != null)
              // no backdrop: the poster, blown up and blurred into a wash
              Opacity(
                opacity: 0.7,
                child: ImageFiltered(imageFilter: ImageFilter.blur(sigmaX: 28, sigmaY: 28), child: Transform.scale(scale: 1.25, child: AuthImage(url: item.posterUrl))),
              )
            else
              Positioned(right: 16, bottom: -20, child: HokagoIcon(iconFor(item.id), size: 150, color: Colors.white.withValues(alpha: 0.6))),
            const _DotOverlay(),
            const Align(
              alignment: Alignment.topCenter,
              child: FractionallySizedBox(
                heightFactor: 0.35,
                widthFactor: 1,
                child: DecoratedBox(
                  decoration: BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0x73000000), Color(0x00000000)])),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// DetailView's banner dot texture (18px white dots at 14%, half opacity).
class _DotOverlay extends StatelessWidget {
  const _DotOverlay();
  @override
  Widget build(BuildContext context) => const RepaintBoundary(child: CustomPaint(painter: _DotPainter()));
}

class _DotPainter extends CustomPainter {
  const _DotPainter();
  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()..color = const Color(0x12FFFFFF);
    for (var y = 9.0; y < size.height; y += 18) {
      for (var x = 9.0; x < size.width; x += 18) {
        canvas.drawCircle(Offset(x, y), 1, p);
      }
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

class _NotDownloaded extends StatelessWidget {
  const _NotDownloaded();
  @override
  Widget build(BuildContext context) => Container(
        margin: const EdgeInsets.only(top: 8),
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 40),
        decoration: BoxDecoration(borderRadius: BorderRadius.circular(26), border: Border.all(color: HokagoColors.line2, width: 2)),
        child: const Column(children: [
          HokagoIcon('download', size: 28, color: HokagoColors.ink2),
          SizedBox(height: 12),
          Text('not downloaded yet', style: HokagoText.section),
          SizedBox(height: 6),
          Text(
            'This title is tracked but no files have landed — drop the episodes into its folder and rescan the library.',
            textAlign: TextAlign.center,
            style: HokagoText.meta,
          ),
        ]),
      );
}

class _SeasonGrid extends StatelessWidget {
  const _SeasonGrid({required this.label, required this.episodes, required this.onOpen, required this.onMenu});
  final String label;
  final List<EpisodeCard> episodes;
  final void Function(EpisodeCard) onOpen;
  final void Function(EpisodeCard) onMenu;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: 28),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SectionTitle(label, count: episodes.length),
          const SizedBox(height: 18),
          LayoutBuilder(builder: (context, c) {
            final cols = (c.maxWidth / 230).floor().clamp(1, 6);
            final w = (c.maxWidth - (cols - 1) * 18) / cols;
            return Wrap(
              spacing: 18,
              runSpacing: 22,
              children: [
                for (final ep in episodes) SizedBox(width: w, child: EpisodeTile(episode: ep, onTap: () => onOpen(ep), onLongPress: () => onMenu(ep))),
              ],
            );
          }),
        ],
      ),
    );
  }
}

/// DetailView.tsx's episode card: framed landscape thumbnail (mono EP badge,
/// watched check, runtime pill, resume bar) + bold title. Watched episodes
/// sit back (dimmed) until focused.
class EpisodeTile extends StatelessWidget {
  const EpisodeTile({super.key, required this.episode, required this.onTap, this.onLongPress});
  final EpisodeCard episode;
  final VoidCallback onTap;
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    final runtime = episode.runtimeMs;
    final progress = !episode.watched && runtime != null && runtime > 0 && episode.positionMs > 0 ? episode.positionMs / runtime : null;
    return Pressable(
      onTap: episode.mediaFileId != null ? onTap : null,
      onLongPress: onLongPress,
      semanticLabel: episode.title,
      builder: (context, focused) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          AnimatedContainer(
            duration: const Duration(milliseconds: 200),
            padding: const EdgeInsets.all(5),
            decoration: BoxDecoration(color: HokagoColors.card, borderRadius: BorderRadius.circular(18), boxShadow: focused ? hokagoWiiRing : hokagoPanelShadow),
            child: AspectRatio(
              aspectRatio: 16 / 9,
              child: Stack(
                fit: StackFit.expand,
                children: [
                  ChannelArt(id: episode.id, url: episode.posterUrl ?? episode.backdropUrl, radius: 13, iconScale: 0.28, dim: episode.watched && !focused),
                  Positioned(left: 9, top: 8, child: _MonoBadge(episode.kind == 'MOVIE' ? 'MOVIE' : 'EP ${episode.episodeNumber ?? '?'}', light: true)),
                  if (episode.watched)
                    Positioned(
                      right: 9,
                      top: 8,
                      child: Container(
                        width: 24,
                        height: 24,
                        decoration: const BoxDecoration(color: HokagoColors.wiiDeep, shape: BoxShape.circle),
                        alignment: Alignment.center,
                        child: const HokagoIcon('check', size: 13, color: Colors.white),
                      ),
                    ),
                  if (runtime != null) Positioned(right: 9, bottom: progress != null ? 13 : 8, child: _MonoBadge('${(runtime / 60000).round()}m')),
                  if (progress != null) Positioned(left: 0, right: 0, bottom: 0, child: WiiProgress(value: progress, height: 5)),
                ],
              ),
            ),
          ),
          const SizedBox(height: 10),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4),
            child: Text(
              episode.title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: HokagoText.cardTitle.copyWith(color: focused ? HokagoColors.wiiDeep : (episode.watched ? HokagoColors.ink3 : HokagoColors.ink)),
            ),
          ),
        ],
      ),
    );
  }
}

class _MonoBadge extends StatelessWidget {
  const _MonoBadge(this.text, {this.light = false});
  final String text;
  final bool light;
  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
        decoration: BoxDecoration(color: light ? HokagoColors.paper : Colors.black.withValues(alpha: 0.55), borderRadius: BorderRadius.circular(HokagoRadii.pill)),
        child: Text(text, style: HokagoText.kicker.copyWith(color: light ? HokagoColors.ink : Colors.white)),
      );
}

class _DetailSkeleton extends StatelessWidget {
  const _DetailSkeleton({required this.itemId});
  final String itemId;
  @override
  Widget build(BuildContext context) {
    return SkeletonScope(
      child: Stack(children: [
        ListView(
          padding: EdgeInsets.zero,
          physics: const NeverScrollableScrollPhysics(),
          children: [
            SizedBox(
              height: 320,
              child: DecoratedBox(decoration: BoxDecoration(gradient: LinearGradient(colors: hueFor(itemId).map((c) => c.withValues(alpha: 0.35)).toList()))),
            ),
            Transform.translate(
              offset: const Offset(0, -96),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 14),
                child: _Sheet(
                  padding: const EdgeInsets.all(20),
                  child: Column(children: [
                    Transform.translate(offset: const Offset(0, -64), child: const SizedBox(width: 132, child: Skeleton(radius: 26, aspectRatio: 2 / 3))),
                    const Skeleton(width: 220, height: 32),
                    const SizedBox(height: 14),
                    const Skeleton(width: 160, height: 16),
                    const SizedBox(height: 22),
                    const Skeleton(width: 150, height: 46),
                    const SizedBox(height: 22),
                    const Skeleton(height: 14),
                    const SizedBox(height: 8),
                    const Skeleton(width: 240, height: 14),
                  ]),
                ),
              ),
            ),
          ],
        ),
        _BackButton(onTap: () => context.pop()),
      ]),
    );
  }
}

class _DownloadVariant {
  const _DownloadVariant({this.maxHeight, this.maxBitrateKbps});
  final int? maxHeight;
  final int? maxBitrateKbps;
}

/// Original = the raw file copied; the rest are server-side re-encodes.
class _DownloadVariantSheet extends StatelessWidget {
  const _DownloadVariantSheet();

  @override
  Widget build(BuildContext context) {
    Widget row(String label, String sub, _DownloadVariant v) => ListTile(
          contentPadding: const EdgeInsets.symmetric(horizontal: 8),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
          leading: const HokagoIcon('download', size: 20, color: HokagoColors.ink2),
          title: Text(label, style: HokagoText.cardTitle.copyWith(fontSize: 15)),
          subtitle: Text(sub),
          onTap: () => Navigator.pop(context, v),
        );
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text('Download quality', style: HokagoText.section),
            const SizedBox(height: 12),
            row('Original', 'Full quality, largest file', const _DownloadVariant()),
            row('1080p', 'Re-encoded, smaller file', const _DownloadVariant(maxHeight: 1080, maxBitrateKbps: 8000)),
            row('720p', 'Re-encoded, smaller file', const _DownloadVariant(maxHeight: 720, maxBitrateKbps: 3500)),
            row('480p', 'Re-encoded, smallest file', const _DownloadVariant(maxHeight: 480, maxBitrateKbps: 1500)),
          ],
        ),
      ),
    );
  }
}
