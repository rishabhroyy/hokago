import 'package:flutter/material.dart';

import '../api/models/home.dart';
import '../theme/app_theme.dart';
import '../theme/hue.dart';
import 'auth_image.dart';
import 'media_tile.dart';
import 'wii_button.dart';

const _heroInterval = Duration(seconds: 5);

/// ui/Hero.tsx's billboard: full-bleed art under the transparent top bar,
/// fading down into the page (the first rail rides up into the fade). On
/// native the slides are a swipeable PageView that auto-advances every 5s
/// and pauses while a finger is on it; the Wii page pills fill over the
/// interval like the web's.
class HokagoHero extends StatefulWidget {
  const HokagoHero({super.key, required this.slides, required this.onPlay, required this.onDetail, required this.height});
  final List<HomeSlide> slides;
  final void Function(HomeSlide) onPlay;
  final void Function(HomeSlide) onDetail;
  final double height;

  @override
  State<HokagoHero> createState() => _HokagoHeroState();
}

class _HokagoHeroState extends State<HokagoHero> with SingleTickerProviderStateMixin {
  final _pages = PageController();
  late final AnimationController _fill = AnimationController(vsync: this, duration: _heroInterval);
  int _active = 0;

  @override
  void initState() {
    super.initState();
    _fill.addStatusListener((s) {
      if (s == AnimationStatus.completed && mounted && widget.slides.length > 1) {
        _pages.animateToPage((_active + 1) % widget.slides.length, duration: const Duration(milliseconds: 600), curve: HokagoMotion.smooth);
      }
    });
    if (widget.slides.length > 1) _fill.forward();
  }

  @override
  void dispose() {
    _fill.dispose();
    _pages.dispose();
    super.dispose();
  }

  void _onPage(int i) {
    setState(() => _active = i);
    if (widget.slides.length > 1) _fill.forward(from: 0);
  }

  @override
  Widget build(BuildContext context) {
    final slides = widget.slides;
    if (slides.isEmpty) return const SizedBox.shrink();
    final wide = isWide(context);
    final gutter = pageGutter(context);
    final reduced = MediaQuery.disableAnimationsOf(context);
    if (reduced) _fill.stop();

    return SizedBox(
      height: widget.height,
      child: Stack(
        fit: StackFit.expand,
        children: [
          NotificationListener<ScrollNotification>(
            onNotification: (n) {
              if (n is ScrollStartNotification && n.dragDetails != null) _fill.stop();
              if (n is ScrollEndNotification && slides.length > 1 && !reduced && !_fill.isAnimating) _fill.forward(from: 0);
              return false;
            },
            child: PageView.builder(
              controller: _pages,
              onPageChanged: _onPage,
              itemCount: slides.length,
              itemBuilder: (context, i) => _Slide(
                slide: slides[i],
                height: widget.height,
                wide: wide,
                gutter: gutter,
                active: i == _active,
                onPlay: () => widget.onPlay(slides[i]),
                onDetail: () => widget.onDetail(slides[i]),
              ),
            ),
          ),
          if (slides.length > 1)
            Positioned(
              left: wide ? null : 0,
              right: wide ? gutter : 0,
              bottom: widget.height * (wide ? 0.24 : 0.07),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: [
                  for (var i = 0; i < slides.length; i++)
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 3),
                      child: _PagePill(index: i, active: _active, fill: _fill, wide: wide),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _Slide extends StatelessWidget {
  const _Slide({required this.slide, required this.height, required this.wide, required this.gutter, required this.active, required this.onPlay, required this.onDetail});
  final HomeSlide slide;
  final double height;
  final bool wide;
  final double gutter;
  final bool active;
  final VoidCallback onPlay;
  final VoidCallback onDetail;

  @override
  Widget build(BuildContext context) {
    final art = slide.backdropUrl ?? slide.posterUrl;
    final meta = [slide.label, slide.sub, slide.year?.toString(), slide.timeLeftLabel].where((x) => x != null && x.isNotEmpty).join(', ');
    return Stack(
      fit: StackFit.expand,
      children: [
        // .art-fade: the art dissolves into the page instead of a hard edge.
        ShaderMask(
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
              DecoratedBox(decoration: BoxDecoration(gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: hueFor(slide.title)))),
              if (art != null) AuthImage(url: art, alignment: wide ? Alignment.center : const Alignment(0.3, -0.2)),
              // legibility: a left-hand shade wide, a heavier bottom one on phones.
              DecoratedBox(
                decoration: BoxDecoration(
                  gradient: wide
                      ? const LinearGradient(
                          colors: [Color(0xD9121110), Color(0x66121110), Color(0x00121110)],
                          stops: [0, 0.38, 0.65],
                        )
                      : const LinearGradient(
                          begin: Alignment.bottomCenter,
                          end: Alignment.topCenter,
                          colors: [Color(0xD9121110), Color(0x33121110), Color(0x00121110)],
                          stops: [0.2, 0.7, 1],
                        ),
                ),
              ),
              // the top bar sits on the art: a soft scrim keeps the status bar readable.
              const Align(
                alignment: Alignment.topCenter,
                child: FractionallySizedBox(
                  heightFactor: 0.22,
                  widthFactor: 1,
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0x80000000), Color(0x00000000)]),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
        Positioned(
          left: gutter,
          right: gutter,
          bottom: height * (wide ? 0.24 : 0.13),
          child: AnimatedSlide(
            offset: active ? Offset.zero : const Offset(0, 0.08),
            duration: const Duration(milliseconds: 500),
            curve: HokagoMotion.smooth,
            child: AnimatedOpacity(
              opacity: active ? 1 : 0,
              duration: const Duration(milliseconds: 500),
              curve: HokagoMotion.smooth,
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 620),
                child: Column(
                  crossAxisAlignment: wide ? CrossAxisAlignment.start : CrossAxisAlignment.center,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      slide.title,
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                      textAlign: wide ? TextAlign.start : TextAlign.center,
                      style: HokagoText.display.copyWith(
                        fontSize: wide ? 48 : 34,
                        height: wide ? 1.04 : 1.1,
                        color: Colors.white,
                        shadows: const [Shadow(color: Color(0x59000000), blurRadius: 24, offset: Offset(0, 2))],
                      ),
                    ),
                    if (meta.isNotEmpty) ...[
                      const SizedBox(height: 10),
                      Text(
                        meta,
                        textAlign: wide ? TextAlign.start : TextAlign.center,
                        style: HokagoText.meta.copyWith(
                          fontSize: wide ? 15 : 13,
                          color: Colors.white.withValues(alpha: 0.8),
                          shadows: const [Shadow(color: Color(0x66000000), blurRadius: 8, offset: Offset(0, 1))],
                        ),
                      ),
                    ],
                    if (slide.progress != null) ...[
                      const SizedBox(height: 14),
                      SizedBox(width: wide ? 320 : 220, child: WiiProgress(value: slide.progress!, height: 6)),
                    ],
                    if (slide.mediaFileId != null || slide.detailId != null) ...[
                      SizedBox(height: wide ? 24 : 20),
                      Wrap(
                        spacing: 12,
                        runSpacing: 10,
                        alignment: WrapAlignment.center,
                        children: [
                          if (slide.mediaFileId != null)
                            WiiButton(icon: 'play', label: slide.progress != null ? 'Resume' : 'Play', onPressed: onPlay),
                          if (slide.detailId != null) WiiButton.ghost(icon: 'info', label: 'More info', onPressed: onDetail),
                        ],
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

/// Wii-style page pill — the active one fills over the rotation interval.
class _PagePill extends StatelessWidget {
  const _PagePill({required this.index, required this.active, required this.fill, required this.wide});
  final int index;
  final int active;
  final Animation<double> fill;
  final bool wide;

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(HokagoRadii.pill),
      child: Container(
        width: wide ? 40 : (index == active ? 22 : 8),
        height: 5,
        color: Colors.white.withValues(alpha: 0.25),
        alignment: Alignment.centerLeft,
        child: index == active
            ? AnimatedBuilder(
                animation: fill,
                builder: (_, _) => FractionallySizedBox(widthFactor: fill.isAnimating || fill.value > 0 ? fill.value : 1, child: const ColoredBox(color: Colors.white)),
              )
            : index < active
                ? const SizedBox.expand(child: ColoredBox(color: Color(0xCCFFFFFF)))
                : null,
      ),
    );
  }
}
