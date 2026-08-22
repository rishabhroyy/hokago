import 'dart:async';

import 'package:flutter/material.dart';

import '../api/models/home.dart';
import '../theme/app_theme.dart';
import 'auth_image.dart';
import 'ghost_button.dart';
import 'wii_button.dart';

const _heroInterval = Duration(seconds: 5);

/// ui/Hero.tsx ported: a "channel bezel" card (card-colored 7px frame around
/// a rounded image area) holding an auto-rotating crossfade carousel — not a
/// plain full-bleed backdrop. Kicker pill badge, display-size title, meta
/// pills, resume progress bar, Play/Details actions, bottom-right progress-
/// fill dot indicators.
class HokagoHero extends StatefulWidget {
  const HokagoHero({super.key, required this.slides, required this.onPlay, required this.onDetail});
  final List<HomeSlide> slides;
  final void Function(HomeSlide) onPlay;
  final void Function(HomeSlide) onDetail;

  @override
  State<HokagoHero> createState() => _HokagoHeroState();
}

class _HokagoHeroState extends State<HokagoHero> {
  int _active = 0;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _startTimer();
  }

  void _startTimer() {
    _timer?.cancel();
    if (widget.slides.length <= 1) return;
    _timer = Timer.periodic(_heroInterval, (_) {
      if (mounted) setState(() => _active = (_active + 1) % widget.slides.length);
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (widget.slides.isEmpty) return const SizedBox.shrink();
    final slide = widget.slides[_active % widget.slides.length];
    final hasPlay = slide.mediaFileId != null;
    final hasDetail = slide.detailId != null;

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: DecoratedBox(
        decoration: BoxDecoration(color: HokagoColors.card, borderRadius: BorderRadius.circular(28), boxShadow: hokagoPanelShadow),
        child: Padding(
          padding: const EdgeInsets.all(7),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(21),
            child: SizedBox(
              height: 400,
              child: Stack(
                fit: StackFit.expand,
                children: [
                  AnimatedSwitcher(
                    duration: const Duration(milliseconds: 500),
                    child: AuthImage(key: ValueKey(slide.title + _active.toString()), url: slide.backdropUrl ?? slide.posterUrl),
                  ),
                  DecoratedBox(
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        begin: Alignment.centerRight,
                        end: Alignment.centerLeft,
                        colors: [const Color(0x14322319), const Color(0xC2322319)],
                        stops: const [0.22, 1.0],
                      ),
                    ),
                  ),
                  Positioned(
                    left: 24,
                    right: 24,
                    bottom: 24,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        _KickerPill(text: slide.label),
                        const SizedBox(height: 10),
                        Text(
                          slide.title,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: HokagoText.display.copyWith(fontSize: 32, color: Colors.white),
                        ),
                        const SizedBox(height: 10),
                        Wrap(
                          spacing: 8,
                          children: [
                            if (slide.sub != null) _MetaPill(slide.sub!),
                            if (slide.year != null) _MetaPill('${slide.year}'),
                            if (slide.timeLeftLabel != null) _MetaPill(slide.timeLeftLabel!),
                          ],
                        ),
                        if (slide.progress != null) ...[
                          const SizedBox(height: 12),
                          ClipRRect(
                            borderRadius: BorderRadius.circular(4),
                            child: SizedBox(
                              width: 220,
                              height: 6,
                              child: LinearProgressIndicator(
                                value: slide.progress!.clamp(0.0, 1.0),
                                backgroundColor: Colors.black26,
                                color: HokagoColors.wii,
                              ),
                            ),
                          ),
                        ],
                        if (hasPlay || hasDetail) ...[
                          const SizedBox(height: 14),
                          Row(
                            children: [
                              if (hasPlay)
                                WiiButton(
                                  icon: Icons.play_arrow_rounded,
                                  onPressed: () => widget.onPlay(slide),
                                  child: Text(slide.progress != null ? 'Resume' : 'Play'),
                                ),
                              if (hasPlay && hasDetail) const SizedBox(width: 10),
                              if (hasDetail)
                                GhostButton(icon: Icons.info_outline_rounded, onPressed: () => widget.onDetail(slide), child: const Text('Details')),
                            ],
                          ),
                        ],
                      ],
                    ),
                  ),
                  if (widget.slides.length > 1)
                    Positioned(
                      right: 20,
                      bottom: 20,
                      child: Row(
                        children: [
                          for (var i = 0; i < widget.slides.length; i++)
                            GestureDetector(
                              onTap: () {
                                setState(() => _active = i);
                                _startTimer();
                              },
                              child: Container(
                                width: 22,
                                height: 4,
                                margin: const EdgeInsets.only(left: 5),
                                decoration: BoxDecoration(
                                  color: i == _active ? Colors.white : Colors.white.withValues(alpha: 0.3),
                                  borderRadius: BorderRadius.circular(2),
                                ),
                              ),
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
    );
  }
}

class _KickerPill extends StatelessWidget {
  const _KickerPill({required this.text});
  final String text;
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(HokagoRadii.pill),
        border: Border.all(color: Colors.white.withValues(alpha: 0.4)),
        color: Colors.white.withValues(alpha: 0.15),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(width: 6, height: 6, decoration: const BoxDecoration(color: Colors.white, shape: BoxShape.circle)),
          const SizedBox(width: 8),
          Text(text.toUpperCase(), style: HokagoText.kicker.copyWith(color: Colors.white)),
        ],
      ),
    );
  }
}

class _MetaPill extends StatelessWidget {
  const _MetaPill(this.text);
  final String text;
  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(HokagoRadii.pill),
        border: Border.all(color: Colors.white.withValues(alpha: 0.4)),
        color: Colors.white.withValues(alpha: 0.15),
      ),
      child: Text(text, style: const TextStyle(fontFamily: 'Plus Jakarta Sans', fontSize: 12, fontWeight: FontWeight.w600, color: Colors.white)),
    );
  }
}
