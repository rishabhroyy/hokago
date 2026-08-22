import 'dart:ui' as ui;

import 'package:flutter/material.dart';

/// The "wii-dream" wallpaper from apps/web/src/app.css's `.dark body::before`
/// — four soft radial-gradient auras (warm top glow, blue top-right, coral
/// left, gold center-bottom) over the espresso base. Ellipse sizes/positions
/// are copied 1:1 from the CSS (percentages of the painted box); Flutter's
/// RadialGradient only draws circles, so each aura is a unit circle drawn
/// inside a save/translate/scale(rx,ry)/restore block to get the same
/// ellipse. The CSS's 28px dot-grid texture is dropped — imperceptible at
/// the sizes this renders on mobile/TV, not worth a second painter pass.
class HokagoBackground extends StatelessWidget {
  const HokagoBackground({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: const BoxDecoration(color: Color(0xFF171410)),
      child: CustomPaint(
        painter: _WallpaperPainter(),
        child: child,
      ),
    );
  }
}

class _Aura {
  const _Aura(this.cx, this.cy, this.rx, this.ry, this.color);
  final double cx, cy, rx, ry; // fractions of the canvas size
  final Color color;
}

class _WallpaperPainter extends CustomPainter {
  static const _auras = [
    _Aura(0.5, -0.10, 1.30, 0.70, Color(0x0DFFF4E0)), // warm top glow, 5%
    _Aura(0.92, -0.04, 0.48, 0.42, Color(0x1763C3E6)), // blue top-right, 9%
    _Aura(-0.02, 0.24, 0.42, 0.38, Color(0x0DF0836F)), // coral left, 5%
    _Aura(0.5, 0.70, 0.36, 0.50, Color(0x0BEDB866)), // gold center-bottom, ~4.5%
  ];

  @override
  void paint(Canvas canvas, Size size) {
    for (final a in _auras) {
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
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
