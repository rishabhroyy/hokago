import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/models/home.dart';
import '../../core/session/session_controller.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/auth_image.dart';
import '../../core/widgets/media_tile.dart';

final homeProvider = FutureProvider.autoDispose<HomeResponse>((ref) async {
  final session = ref.watch(sessionProvider);
  final api = ref.read(sessionProvider.notifier).api;
  return api.home(profileId: session.profileId);
});

class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final home = ref.watch(homeProvider);
    return Scaffold(
      body: RefreshIndicator(
        onRefresh: () => ref.refresh(homeProvider.future),
        child: home.when(
          loading: () => const Center(child: CircularProgressIndicator()),
          error: (e, _) => _ErrorState(message: '$e', onRetry: () => ref.invalidate(homeProvider)),
          data: (data) => _HomeContent(data: data),
        ),
      ),
    );
  }
}

class _HomeContent extends StatelessWidget {
  const _HomeContent({required this.data});
  final HomeResponse data;

  void _openDetail(BuildContext context, String? id) {
    if (id != null) context.push('/title/$id');
  }

  @override
  Widget build(BuildContext context) {
    final hero = data.slides.isNotEmpty ? data.slides.first : null;
    return CustomScrollView(
      slivers: [
        if (hero != null)
          SliverToBoxAdapter(child: _Hero(slide: hero, onTap: () => _openDetail(context, hero.detailId))),
        SliverToBoxAdapter(child: const SizedBox(height: 12)),
        for (final row in data.rows)
          SliverToBoxAdapter(
            child: MediaRail(
              title: row.title,
              subtitle: row.subtitle,
              items: row.items,
              onTapItem: (item) => _openDetail(context, item.id),
            ),
          ),
        const SliverToBoxAdapter(child: SizedBox(height: 24)),
      ],
    );
  }
}

class _Hero extends StatelessWidget {
  const _Hero({required this.slide, required this.onTap});
  final HomeSlide slide;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: AspectRatio(
        aspectRatio: 16 / 10,
        child: Stack(
          fit: StackFit.expand,
          children: [
            AuthImage(url: slide.backdropUrl ?? slide.posterUrl),
            DecoratedBox(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: [Colors.transparent, HokagoColors.bg.withValues(alpha: 0.95)],
                  stops: const [0.4, 1.0],
                ),
              ),
            ),
            Positioned(
              left: 16,
              right: 16,
              bottom: 16,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(slide.label.toUpperCase(), style: HokagoText.kicker),
                  const SizedBox(height: 4),
                  Text(
                    slide.title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: HokagoText.titleXl.copyWith(fontSize: 30),
                  ),
                  if (slide.sub != null)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(slide.sub!, style: HokagoText.meta),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _ErrorState extends StatelessWidget {
  const _ErrorState({required this.message, required this.onRetry});
  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.wifi_off_rounded, color: HokagoColors.ink3, size: 40),
            const SizedBox(height: 12),
            Text(message, textAlign: TextAlign.center, style: const TextStyle(color: HokagoColors.ink2)),
            const SizedBox(height: 16),
            OutlinedButton(onPressed: onRetry, child: const Text('Retry')),
          ],
        ),
      ),
    );
  }
}
