import 'dart:ui';

import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

/// The frosted floating panel from app.css's `.dark .panel` — translucent
/// charcoal + backdrop blur + soft shadow. Used for login/setup cards and
/// any surface that should read as "floating" over the wallpaper rather than
/// flush with the background (that's HokagoColors.card / CardTheme instead).
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
            color: const Color(0xE02B2722),
            borderRadius: radius,
            border: Border.all(color: const Color(0x12FFFFFF)),
            boxShadow: const [
              BoxShadow(color: Color(0x73000000), blurRadius: 6, spreadRadius: -2, offset: Offset(0, 2)),
              BoxShadow(color: Color(0xA6000000), blurRadius: 44, spreadRadius: -18, offset: Offset(0, 18)),
            ],
          ),
          child: child,
        ),
      ),
    );
  }
}
