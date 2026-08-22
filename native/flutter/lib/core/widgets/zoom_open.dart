import 'dart:async';
import 'package:flutter/material.dart';

/// ui/effects.ts's zoomOpen, ported: the tapped tile flattens to its own
/// dominant color, grows to fill the screen with a diagonal sheen, then
/// flashes white before the destination page (already navigated-to
/// underneath) is revealed. The signature "wii channel opens" transition —
/// not a slide, not an image-morphing Hero.
void zoomOpen({
  required BuildContext context,
  required GlobalKey artKey,
  required Color color,
  required VoidCallback navigate,
}) {
  final box = artKey.currentContext?.findRenderObject() as RenderBox?;
  if (box == null || !box.attached) {
    navigate();
    return;
  }
  final origin = box.localToGlobal(Offset.zero);
  final startRect = origin & box.size;
  final screen = MediaQuery.sizeOf(context);
  final endRect = Offset.zero & screen;
  final overlayState = Overlay.of(context, rootOverlay: true);

  var navigated = false;
  void doNavigate() {
    if (navigated) return;
    navigated = true;
    navigate();
  }

  late OverlayEntry entry;
  entry = OverlayEntry(
    builder: (_) => _ZoomOpenOverlay(
      startRect: startRect,
      endRect: endRect,
      color: color,
      onNavigate: doNavigate,
      onDone: () => entry.remove(),
    ),
  );
  overlayState.insert(entry);
}

class _ZoomOpenOverlay extends StatefulWidget {
  const _ZoomOpenOverlay({required this.startRect, required this.endRect, required this.color, required this.onNavigate, required this.onDone});
  final Rect startRect;
  final Rect endRect;
  final Color color;
  final VoidCallback onNavigate;
  final VoidCallback onDone;

  @override
  State<_ZoomOpenOverlay> createState() => _ZoomOpenOverlayState();
}

class _ZoomOpenOverlayState extends State<_ZoomOpenOverlay> with SingleTickerProviderStateMixin {
  late final AnimationController _grow = AnimationController(vsync: this, duration: const Duration(milliseconds: 340));
  late final AnimationController _flash = AnimationController(vsync: this, duration: const Duration(milliseconds: 240));
  late final Animation<Rect?> _rect = RectTween(begin: widget.startRect, end: widget.endRect)
      .animate(CurvedAnimation(parent: _grow, curve: Curves.easeOutCubic));
  late final Animation<double> _radius = Tween<double>(begin: 20, end: 0).animate(CurvedAnimation(parent: _grow, curve: Curves.easeOutCubic));

  @override
  void initState() {
    super.initState();
    Timer(const Duration(milliseconds: 90), widget.onNavigate);
    _grow.forward().whenComplete(() {
      _flash.forward().whenComplete(() {
        Future.delayed(const Duration(milliseconds: 60), widget.onDone);
      });
    });
  }

  @override
  void dispose() {
    _grow.dispose();
    _flash.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: AnimatedBuilder(
        animation: Listenable.merge([_grow, _flash]),
        builder: (_, __) {
          final r = _rect.value ?? widget.endRect;
          return Stack(
            children: [
              Positioned.fromRect(
                rect: r,
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(_radius.value),
                  child: DecoratedBox(
                    decoration: BoxDecoration(color: widget.color),
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        gradient: LinearGradient(
                          begin: Alignment.topLeft,
                          end: Alignment.bottomRight,
                          colors: [Colors.white.withValues(alpha: 0.34), Colors.white.withValues(alpha: 0.06), Colors.black.withValues(alpha: 0.14)],
                          stops: const [0.0, 0.4, 1.0],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
              if (_grow.isCompleted)
                Positioned.fill(
                  child: Opacity(
                    opacity: (1 - _flash.value).clamp(0.0, 1.0) * 0.55,
                    child: const DecoratedBox(decoration: BoxDecoration(color: Colors.white)),
                  ),
                ),
            ],
          );
        },
      ),
    );
  }
}
