import 'dart:ui';

import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

/// The frosted floating panel from app.css's `.panel` (light — the web's
/// default theme) — translucent white + backdrop blur + soft warm shadow.
/// Used for login/setup cards and any surface that should read as "floating"
/// over the wallpaper rather than flush with the background (that's
/// HokagoColors.card / CardTheme instead).
class HokagoPanel extends StatelessWidget {
  const HokagoPanel({super.key, required this.child, this.padding, this.borderRadius});
  final Widget child;
  final EdgeInsetsGeometry? padding;
  final double? borderRadius;

  @override
  Widget build(BuildContext context) {
    final radius = BorderRadius.circular(borderRadius ?? HokagoRadii.panel);
    return ClipRRect(
      borderRadius: radius,
      child: BackdropFilter(
        filter: ImageFilter.blur(sigmaX: 10, sigmaY: 10),
        child: Container(
          padding: padding,
          decoration: BoxDecoration(
            color: HokagoColors.panelFill,
            borderRadius: radius,
            border: Border.all(color: HokagoColors.panelBorder),
            boxShadow: hokagoPanelShadow,
          ),
          child: child,
        ),
      ),
    );
  }
}
