import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import 'app_theme.dart';

/// The "wii-dream" wallpaper from apps/web/src/app.css's `body::before` (both
/// themes) — four soft radial-gradient auras (warm top glow, blue top-right,
/// coral left, gold center-bottom) over the paper base. Ellipse sizes/
/// positions are copied 1:1 from the CSS (percentages of the painted box);
/// Flutter's RadialGradient only draws circles, so each aura is a unit
/// circle drawn inside a save/translate/scale(rx,ry)/restore block to get
/// the same ellipse. The CSS's 28px dot-grid texture is dropped —
/// imperceptible at the sizes this renders on mobile/TV, not worth a second
/// painter pass. Reads HokagoColors directly (not a const palette) so it
/// repaints correctly when the light/dark toggle flips.
class HokagoBackground extends StatelessWidget {
  const HokagoBackground({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(color: HokagoColors.bg),
      child: CustomPaint(
        painter: _WallpaperPainter(HokagoColors.wallpaperAuras),
        child: child,
      ),
    );
  }
}

class _WallpaperPainter extends CustomPainter {
  _WallpaperPainter(this.auras);
  final List<({double cx, double cy, double rx, double ry, Color color})> auras;

  @override
  void paint(Canvas canvas, Size size) {
    for (final a in auras) {
      final center = Offset(a.cx * size.width, a.cy * size.height);
      final rx = a.rx * size.width;
      final ry = a.ry * size.height;
      if (rx <= 0 || ry <= 0) continue;
      canvas.save();
      canvas.translate(center.dx, center.dy);
      canvas.scale(rx, ry);
      final paint = Paint()
        ..shader = ui.Gradient.radial(Offset.zero, 1, [a.color, a.color.withAlpha(0)], const [0.0, 1.0]);
      canvas.drawCircle(Offset.zero, 1, paint);
      canvas.restore();
    }
  }

  @override
  bool shouldRepaint(covariant _WallpaperPainter oldDelegate) => oldDelegate.auras != auras;
}
