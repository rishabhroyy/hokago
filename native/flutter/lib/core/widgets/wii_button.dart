import 'dart:ui';

import 'package:flutter/material.dart';

import '../theme/app_theme.dart';
import 'hokago_icon.dart';
import 'pressable.dart';

/// app.css's two pill buttons: `.btn-primary` (glossy Wii-blue gradient,
/// inset highlight, blue drop glow) and `.btn-ghost` (frosted charcoal pill),
/// both with the `.btn::after` top sheen. One height everywhere; [compact]
/// is the smaller pill used for Back / chips.
class WiiButton extends StatelessWidget {
  const WiiButton({super.key, required this.onPressed, required this.label, this.icon, this.compact = false, this.busy = false, this.autofocus = false})
    : ghost = false;
  const WiiButton.ghost({super.key, required this.onPressed, required this.label, this.icon, this.compact = false, this.busy = false, this.autofocus = false})
    : ghost = true;

  final VoidCallback? onPressed;
  final String label;
  final String? icon;
  final bool ghost;
  final bool compact;
  final bool busy;
  final bool autofocus;

  @override
  Widget build(BuildContext context) {
    final disabled = onPressed == null || busy;
    final fg = ghost ? HokagoColors.ink : Colors.white;
    final content = Padding(
      padding: compact ? const EdgeInsets.symmetric(horizontal: 18, vertical: 10) : const EdgeInsets.symmetric(horizontal: 26, vertical: 13),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (busy)
            SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: fg))
          else if (icon != null)
            HokagoIcon(icon!, size: compact ? 15 : 16, color: fg),
          if (busy || icon != null) SizedBox(width: compact ? 8 : 10),
          Flexible(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: HokagoText.button.copyWith(
                fontSize: compact ? 13 : 14.5,
                color: fg,
                shadows: ghost ? null : const [Shadow(color: Color(0x66177A9E), offset: Offset(0, 1), blurRadius: 2)],
              ),
            ),
          ),
        ],
      ),
    );
    return Pressable(
      onTap: disabled ? null : onPressed,
      autofocus: autofocus,
      builder: (context, focused) => AnimatedOpacity(
        opacity: disabled && !busy ? 0.55 : 1,
        duration: const Duration(milliseconds: 150),
        child: DecoratedBox(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(HokagoRadii.pill),
            boxShadow: focused
                ? hokagoWiiRing
                : ghost
                ? const [BoxShadow(color: Color(0x80000000), blurRadius: 12, spreadRadius: -4, offset: Offset(0, 4))]
                : const [BoxShadow(color: Color(0xA62E9BC4), blurRadius: 18, spreadRadius: -6, offset: Offset(0, 6))],
          ),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(HokagoRadii.pill),
            child: ghost
                ? BackdropFilter(
                    filter: ImageFilter.blur(sigmaX: 8, sigmaY: 8),
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        color: HokagoColors.ghostFill,
                        borderRadius: BorderRadius.circular(HokagoRadii.pill),
                        border: Border.all(color: HokagoColors.ghostBorder),
                      ),
                      child: _Sheen(strength: 0.08, child: content),
                    ),
                  )
                : DecoratedBox(
                    decoration: const BoxDecoration(
                      gradient: LinearGradient(
                        begin: Alignment.topCenter,
                        end: Alignment.bottomCenter,
                        colors: [HokagoColors.wiiBtnTop, HokagoColors.wiiBtnBottom],
                      ),
                    ),
                    child: _Sheen(strength: 0.5, child: content),
                  ),
          ),
        ),
      ),
    );
  }
}

/// `.btn::after`: the glossy highlight over the top ~46% of the pill.
class _Sheen extends StatelessWidget {
  const _Sheen({required this.child, required this.strength});
  final Widget child;
  final double strength;

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        child,
        Positioned.fill(
          child: IgnorePointer(
            child: FractionallySizedBox(
              alignment: Alignment.topCenter,
              heightFactor: 0.46,
              widthFactor: 0.88,
              child: DecoratedBox(
                decoration: BoxDecoration(
                  borderRadius: const BorderRadius.vertical(top: Radius.circular(100), bottom: Radius.elliptical(60, 12)),
                  gradient: LinearGradient(
                    begin: Alignment.topCenter,
                    end: Alignment.bottomCenter,
                    colors: [
                      Colors.white.withValues(alpha: strength),
                      Colors.white.withValues(alpha: 0),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

/// Round icon-only glass button (detail Back, player chrome, nav icons).
class GlassIconButton extends StatelessWidget {
  const GlassIconButton({super.key, required this.icon, required this.onPressed, this.size = 40, this.semanticLabel});
  final String icon;
  final VoidCallback? onPressed;
  final double size;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    return Pressable(
      onTap: onPressed,
      pressedScale: 0.88,
      semanticLabel: semanticLabel,
      builder: (context, focused) => ClipOval(
        child: BackdropFilter(
          filter: ImageFilter.blur(sigmaX: 10, sigmaY: 10),
          child: Container(
            width: size,
            height: size,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: Colors.black.withValues(alpha: 0.32),
              border: Border.all(color: focused ? HokagoColors.wii : Colors.white.withValues(alpha: 0.14), width: focused ? 2.5 : 1),
            ),
            child: HokagoIcon(icon, size: size * 0.45, color: Colors.white),
          ),
        ),
      ),
    );
  }
}

/// SearchView's filter / suggestion chip: the glossy Wii pill when selected,
/// a quiet paper pill with a hairline otherwise.
class WiiChip extends StatelessWidget {
  const WiiChip({super.key, required this.label, required this.onTap, this.selected = false});
  final String label;
  final VoidCallback onTap;
  final bool selected;

  @override
  Widget build(BuildContext context) {
    return Pressable(
      onTap: onTap,
      pressedScale: 0.94,
      builder: (context, focused) => AnimatedContainer(
        duration: const Duration(milliseconds: 180),
        curve: HokagoMotion.snap,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(HokagoRadii.pill),
          gradient: selected
              ? const LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [HokagoColors.wiiBtnTop, HokagoColors.wiiBtnBottom])
              : null,
          color: selected ? null : HokagoColors.paper,
          border: selected ? null : Border.all(color: focused ? HokagoColors.wii : HokagoColors.line),
          boxShadow: focused
              ? hokagoWiiRing
              : (selected ? const [BoxShadow(color: Color(0x992E9BC4), blurRadius: 10, spreadRadius: -3, offset: Offset(0, 3))] : null),
        ),
        child: Text(
          label,
          style: HokagoText.meta.copyWith(fontWeight: FontWeight.w700, color: selected ? Colors.white : HokagoColors.ink2),
        ),
      ),
    );
  }
}
