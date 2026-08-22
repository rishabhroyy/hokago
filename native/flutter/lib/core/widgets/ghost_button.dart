import 'dart:ui';

import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

/// app.css's `.dark .btn-ghost` — frosted charcoal pill, secondary action
/// (paired with WiiButton for primary). "Details" next to "Play" in the hero.
class GhostButton extends StatelessWidget {
  const GhostButton({super.key, required this.onPressed, required this.child, this.icon});
  final VoidCallback? onPressed;
  final Widget child;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(HokagoRadii.pill),
      child: BackdropFilter(
        filter: ImageFilter.blur(sigmaX: 8, sigmaY: 8),
        child: Material(
          color: const Color(0xE0262219),
          child: InkWell(
            onTap: onPressed,
            child: Container(
              decoration: BoxDecoration(border: Border.all(color: const Color(0x1AFFFFFF))),
              padding: const EdgeInsets.symmetric(horizontal: 26, vertical: 13),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (icon != null) ...[
                    Icon(icon, color: HokagoColors.ink, size: 18),
                    const SizedBox(width: 10),
                  ],
                  DefaultTextStyle(
                    style: const TextStyle(fontFamily: 'Plus Jakarta Sans', color: HokagoColors.ink, fontSize: 14.5, fontWeight: FontWeight.w700),
                    child: child,
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
