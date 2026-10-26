import 'dart:async';
import 'dart:math';
import 'dart:ui';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/models/home.dart';
import '../../core/downloads/offline_watch_queue.dart';
import '../../core/platform.dart';
import '../../core/session/session_controller.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/hokago_hero.dart';
import '../../core/widgets/hokago_icon.dart';
import '../../core/widgets/media_tile.dart';
import '../../core/widgets/skeleton.dart';
import '../../core/widgets/wii_button.dart';
import '../common/states.dart';
import '../common/tile_actions.dart';

/// HomeView's variety pass: items shuffled within every rail and the genre
/// rails' order rotated — once per fetch, so the shelf rearranges per visit
/// but never under the user's thumb.
final homeProvider = FutureProvider.autoDispose<HomeResponse>((ref) async {
  final profileId = ref.watch(sessionProvider.select((s) => s.profileId));
  final api = ref.read(sessionProvider.notifier).api;
  // Offline-playback progress rides along with every home load (concurrent,
  // so an unreachable server costs one timeout, not two).
  if (profileId != null) unawaited(OfflineWatchQueue.instance.flush(api, profileId));
  final home = await api.home(profileId: profileId);
  final rng = Random();
  final genre = home.rows.where((r) => r.id.startsWith('genre:')).toList()..shuffle(rng);
  final rows = [...home.rows.where((r) => !r.id.startsWith('genre:')), ...genre]
      .map((r) => HomeRow(id: r.id, title: r.title, subtitle: r.subtitle, items: [...r.items]..shuffle(rng)))
      .toList();
  return HomeResponse(continueWatching: home.continueWatching, slides: home.slides, rows: rows);
});

class HomeScreen extends ConsumerStatefulWidget {
  const HomeScreen({super.key});
  @override
  ConsumerState<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends ConsumerState<HomeScreen> {
  final _scroll = ScrollController();
  final _scrolled = ValueNotifier(false);

  @override
  void initState() {
    super.initState();
    _scroll.addListener(() => _scrolled.value = _scroll.offset > 24);
  }

  @override
  void dispose() {
    _scroll.dispose();
    _scrolled.dispose();
    super.dispose();
  }

  void _openDetail(String? id) {
    if (id != null) context.push('/title/$id');
  }

  void _playSlide(HomeSlide slide) {
    if (slide.mediaFileId == null || slide.mediaItemId == null) return;
    final series = slide.detailId != null && slide.detailId != slide.mediaItemId ? '&series=${slide.detailId}' : '';
    context.push('/watch/${slide.mediaFileId}?mediaItemId=${slide.mediaItemId}$series');
  }

  @override
  Widget build(BuildContext context) {
    final home = ref.watch(homeProvider);
    final size = MediaQuery.sizeOf(context);
    final wide = isWide(context);
    final heroH = wide ? min(size.height * 0.82, 820.0).clamp(540.0, 820.0) : max(size.height * 0.74, 460.0);

    final body = switch (home) {
      AsyncData(:final value) => _content(value, heroH, wide),
      AsyncError() when !home.isLoading => MessageState(
          icon: 'wifi-off',
          title: "Can't reach your server",
          message: 'Your downloads still play offline. Pull to retry, or check the server is up.',
          actionLabel: 'Try again',
          onAction: () => ref.invalidate(homeProvider),
        ),
      _ => _HomeSkeleton(heroH: heroH),
    };

    return Scaffold(
      body: Stack(
        children: [
          RefreshIndicator(
            edgeOffset: MediaQuery.paddingOf(context).top + 56,
            onRefresh: () => ref.refresh(homeProvider.future),
            child: body,
          ),
          _TopBar(scrolled: _scrolled),
        ],
      ),
    );
  }

  Widget _content(HomeResponse data, double heroH, bool wide) {
    if (data.continueWatching.isEmpty && data.slides.isEmpty && data.rows.isEmpty) {
      return ListView(
        children: [
          SizedBox(
            height: MediaQuery.sizeOf(context).height * 0.85,
            child: const MessageState(
              icon: 'logo',
              title: 'welcome to hokago',
              message: 'Nothing on the menu yet — add a library from the admin panel on the web, and your channels show up here.',
            ),
          ),
        ],
      );
    }
    final hasHero = data.slides.isNotEmpty;
    final top = MediaQuery.paddingOf(context).top;
    void refresh() => ref.invalidate(homeProvider);
    return CustomScrollView(
      controller: _scroll,
      physics: const AlwaysScrollableScrollPhysics(),
      slivers: [
        SliverToBoxAdapter(
          child: hasHero
              ? HokagoHero(slides: data.slides, height: heroH, onPlay: _playSlide, onDetail: (s) => _openDetail(s.detailId))
              : SizedBox(height: top + 64),
        ),
        // the first rail rides up into the hero's fade
        SliverToBoxAdapter(
          child: Transform.translate(
            offset: Offset(0, hasHero ? -heroH * (wide ? 0.18 : 0.06) : 0),
            child: Column(
              children: [
                MediaRail(
                  title: 'Continue watching',
                  items: data.continueWatching.map(continueWatchingToTile).toList(),
                  onOpen: (t) => _openDetail(t.detailId ?? t.id),
                  onLongPress: (t) => showTileActions(context, ref, t, onChanged: refresh),
                ),
                for (final row in data.rows)
                  MediaRail(
                    title: row.title,
                    items: row.items.map(cardToTile).toList(),
                    onOpen: (t) => _openDetail(t.id),
                    onLongPress: (t) => showTileActions(context, ref, t, onChanged: refresh),
                  ),
              ],
            ),
          ),
        ),
        SliverPadding(padding: EdgeInsets.only(bottom: MediaQuery.paddingOf(context).bottom)),
      ],
    );
  }
}

/// TopNav.tsx on a phone: transparent over the billboard, frosted glass once
/// content scrolls under it. Watch party join lives here (web: /party).
class _TopBar extends StatelessWidget {
  const _TopBar({required this.scrolled});
  final ValueListenable<bool> scrolled;

  @override
  Widget build(BuildContext context) {
    final top = MediaQuery.paddingOf(context).top;
    return ValueListenableBuilder<bool>(
      valueListenable: scrolled,
      builder: (context, isScrolled, child) => ClipRect(
        child: TweenAnimationBuilder<double>(
          tween: Tween(end: isScrolled ? 1 : 0),
          duration: const Duration(milliseconds: 300),
          builder: (context, t, child) => BackdropFilter(
            enabled: t > 0,
            filter: ImageFilter.blur(sigmaX: 24 * t, sigmaY: 24 * t),
            child: ColoredBox(color: HokagoColors.paper.withValues(alpha: 0.7 * t), child: child),
          ),
          child: child,
        ),
      ),
      child: Padding(
        padding: EdgeInsets.fromLTRB(pageGutter(context), top + 8, pageGutter(context) - 8, 8),
        child: Row(
          children: [
            // wide / TV: the side rail already carries the mark
            if (!isWide(context) && !isTvBuild) ...[
              const HokagoLogoMark(size: 26),
              const SizedBox(width: 8),
              Text('hokago', style: HokagoText.section.copyWith(fontSize: 20, color: Colors.white)),
            ],
            const Spacer(),
            GlassIconButton(icon: 'users', semanticLabel: 'Join a watch party', onPressed: () => context.push('/party')),
          ],
        ),
      ),
    );
  }
}

class _HomeSkeleton extends StatelessWidget {
  const _HomeSkeleton({required this.heroH});
  final double heroH;

  @override
  Widget build(BuildContext context) {
    final gutter = pageGutter(context);
    return SkeletonScope(
      child: ListView(
        physics: const AlwaysScrollableScrollPhysics(),
        padding: EdgeInsets.zero,
        children: [
          SizedBox(height: heroH, child: const Skeleton(radius: 0)),
          for (var r = 0; r < 2; r++)
            Padding(
              padding: EdgeInsets.fromLTRB(gutter, 28, 0, 0),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Skeleton(width: 160, height: 20),
                  const SizedBox(height: 16),
                  SizedBox(
                    height: 200,
                    child: ListView.separated(
                      scrollDirection: Axis.horizontal,
                      physics: const NeverScrollableScrollPhysics(),
                      itemCount: 6,
                      separatorBuilder: (_, _) => const SizedBox(width: 14),
                      itemBuilder: (_, _) => const SizedBox(width: 132, child: Skeleton(radius: 20, aspectRatio: 2 / 3)),
                    ),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
