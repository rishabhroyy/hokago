import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/models/home.dart';
import '../../core/session/session_controller.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/hokago_hero.dart';
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

  void _playSlide(BuildContext context, HomeSlide slide) {
    if (slide.mediaFileId == null || slide.mediaItemId == null) return;
    context.push('/watch/${slide.mediaFileId}?mediaItemId=${slide.mediaItemId}');
  }

  @override
  Widget build(BuildContext context) {
    return CustomScrollView(
      slivers: [
        const SliverToBoxAdapter(child: SizedBox(height: 8)),
        if (data.slides.isNotEmpty)
          SliverToBoxAdapter(
            child: HokagoHero(
              slides: data.slides,
              onPlay: (slide) => _playSlide(context, slide),
              onDetail: (slide) => _openDetail(context, slide.detailId),
            ),
          ),
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
            Icon(Icons.wifi_off_rounded, color: HokagoColors.ink3, size: 40),
            const SizedBox(height: 12),
            Text(message, textAlign: TextAlign.center, style: TextStyle(color: HokagoColors.ink2)),
            const SizedBox(height: 16),
            OutlinedButton(onPressed: onRetry, child: const Text('Retry')),
          ],
        ),
      ),
    );
  }
}
