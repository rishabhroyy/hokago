import 'dart:ui';

import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

/// app.css's `.dark .panel`: translucent charcoal + backdrop blur + the soft
/// two-layer shadow, with a faint top sheen (the CSS's inset highlight).
/// Login/setup cards and anything that should float over the wallpaper.
class HokagoPanel extends StatelessWidget {
  const HokagoPanel({super.key, required this.child, this.padding, this.borderRadius});
  final Widget child;
  final EdgeInsetsGeometry? padding;
  final double? borderRadius;

  @override
  Widget build(BuildContext context) {
    final radius = BorderRadius.circular(borderRadius ?? HokagoRadii.panel);
    // Shadow outside the clip — inside it the ClipRRect would cut it off.
    return DecoratedBox(
      decoration: BoxDecoration(borderRadius: radius, boxShadow: hokagoPanelShadow),
      child: ClipRRect(
        borderRadius: radius,
        child: BackdropFilter(
          filter: ImageFilter.blur(sigmaX: 10, sigmaY: 10),
          child: Container(
            padding: padding,
            decoration: BoxDecoration(
              borderRadius: radius,
              border: Border.all(color: HokagoColors.panelBorder),
              gradient: const LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: [Color(0xE6332E28), HokagoColors.panelFill],
                stops: [0, 0.18],
              ),
            ),
            child: child,
          ),
        ),
      ),
    );
  }
}
