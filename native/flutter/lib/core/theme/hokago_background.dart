import 'dart:ui' as ui;

import 'package:flutter/material.dart';


/// The web's dark wallpaper (`.dark body::before`) + `<Backdrop/>` scenery:
/// a top-lit charcoal gradient with four soft auras (Wii blue top-right,
/// coral top-left, faint coral/blue in the lower corners), the Wii Menu dot
/// grid fading out down the page, and manga screentone in two corners.
/// Static — painted once into its own layer, never repaints on scroll.
class HokagoBackground extends StatelessWidget {
  const HokagoBackground({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Stack(
      fit: StackFit.expand,
      children: [
        const RepaintBoundary(child: CustomPaint(painter: _WallpaperPainter())),
        child,
      ],
    );
  }
}

// (cx, cy, rx, ry, color, stop) — CSS `radial-gradient(rx ry at cx cy, color, transparent stop)`.
const _auras = <(double, double, double, double, Color, double)>[
  (0.95, -0.10, 0.80, 0.70, Color(0x6B4FB8E0), 0.70),
  (-0.05, 0.00, 0.65, 0.60, Color(0x38F0836F), 0.70),
  (1.00, 1.10, 0.70, 0.60, Color(0x1FF0836F), 0.70),
  (0.00, 1.00, 0.60, 0.55, Color(0x1F4FB8E0), 0.70),
];

class _WallpaperPainter extends CustomPainter {
  const _WallpaperPainter();

  @override
  void paint(Canvas canvas, Size size) {
    final rect = Offset.zero & size;
    canvas.drawRect(
      rect,
      Paint()
        ..shader = ui.Gradient.linear(
          rect.topCenter,
          rect.bottomCenter,
          const [Color(0xFF1F2533), Color(0xFF14161D), Color(0xFF0B0C10)],
          const [0, 0.5, 1],
        ),
    );
    // Flutter's radial gradient is circle-only: draw a unit circle under a
    // per-aura scale(rx, ry) to get the CSS ellipse.
    for (final (cx, cy, rx, ry, color, stop) in _auras) {
      canvas.save();
      canvas.translate(cx * size.width, cy * size.height);
      canvas.scale(rx * size.width, ry * size.height);
      canvas.drawCircle(
        Offset.zero,
        1,
        Paint()..shader = ui.Gradient.radial(Offset.zero, 1, [color, color.withAlpha(0)], [0, stop]),
      );
      canvas.restore();
    }

    // .backdrop-grid: 26px dots, strongest at the top, ~25% by the bottom.
    const grid = 26.0;
    final dot = Paint();
    for (var y = grid / 2; y < size.height; y += grid) {
      final fade = 1 - 0.75 * (y / size.height);
      dot.color = Color.fromRGBO(143, 224, 245, 0.17 * fade);
      for (var x = grid / 2; x < size.width; x += grid) {
        canvas.drawCircle(Offset(x, y), 1, dot);
      }
    }

    // .backdrop-tone: coral halftone swelling into the top-left and
    // bottom-right corners (the CSS mask radii, approximated per dot).
    const tone = 9.0;
    final rx = size.width * 0.45, ry = size.height * 0.5;
    final rx2 = size.width * 0.5, ry2 = size.height * 0.55;
    for (var y = 0.0; y < size.height; y += tone) {
      for (var x = 0.0; x < size.width; x += tone) {
        final a = 1 - _ellipse(x, y, 0, 0, rx, ry);
        final b = 0.8 * (1 - _ellipse(x, y, size.width, size.height, rx2, ry2));
        final m = a > b ? a : b;
        if (m <= 0) continue;
        dot.color = Color.fromRGBO(240, 131, 111, 0.22 * m);
        canvas.drawCircle(Offset(x, y), 1.6, dot);
      }
    }
  }

  static double _ellipse(double x, double y, double cx, double cy, double rx, double ry) {
    final dx = (x - cx) / rx, dy = (y - cy) / ry;
    final d = dx * dx + dy * dy;
    return d >= 1 ? 1 : d;
  }

  @override
  bool shouldRepaint(covariant _WallpaperPainter oldDelegate) => false;
}
