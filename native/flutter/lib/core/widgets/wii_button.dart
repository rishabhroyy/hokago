import 'package:flutter/material.dart';

import '../theme/app_theme.dart';

/// The glossy wii-blue pill — apps/web/src/app.css's `.btn-primary` /
/// `.wii-btn`, ported exactly: linear gradient #45ADDD→#187AA5, inset top
/// highlight + soft drop shadow, 999px pill radius, scale-down on press.
/// This is hokago's one "primary action" affordance (Play, Continue, etc.) —
/// distinct from the plain accent-colored buttons used for secondary actions.
class WiiButton extends StatefulWidget {
  const WiiButton({super.key, required this.onPressed, required this.child, this.icon});
  final VoidCallback? onPressed;
  final Widget child;
  final IconData? icon;

  @override
  State<WiiButton> createState() => _WiiButtonState();
}

class _WiiButtonState extends State<WiiButton> {
  bool _pressed = false;

  @override
  Widget build(BuildContext context) {
    final disabled = widget.onPressed == null;
    return GestureDetector(
      onTapDown: disabled ? null : (_) => setState(() => _pressed = true),
      onTapCancel: () => setState(() => _pressed = false),
      onTapUp: (_) => setState(() => _pressed = false),
      onTap: widget.onPressed,
      child: AnimatedScale(
        scale: _pressed ? 0.96 : 1.0,
        duration: const Duration(milliseconds: 120),
        curve: Curves.easeOut,
        child: Opacity(
          opacity: disabled ? 0.55 : 1.0,
          child: DecoratedBox(
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(HokagoRadii.pill),
              gradient: const LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: [HokagoColors.wiiBtnTop, HokagoColors.wiiBtnBottom],
              ),
              boxShadow: const [
                BoxShadow(color: Color(0xA62E9BC4), blurRadius: 18, offset: Offset(0, 6), spreadRadius: -6),
              ],
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 13),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (widget.icon != null) ...[
                    Icon(widget.icon, color: Colors.white, size: 20),
                    const SizedBox(width: 10),
                  ],
                  DefaultTextStyle(
                    style: const TextStyle(
                      fontFamily: 'Plus Jakarta Sans',
                      color: Colors.white,
                      fontSize: 14.5,
                      fontWeight: FontWeight.w700,
                      shadows: [Shadow(color: Color(0x66177A9E), offset: Offset(0, 1), blurRadius: 2)],
                    ),
                    child: widget.child,
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
