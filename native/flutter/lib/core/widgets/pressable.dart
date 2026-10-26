import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme/app_theme.dart';

/// The one tappable primitive: press-scale on the Wii spring (`ease-snap`),
/// and real focus — D-pad / keyboard traversal and select/enter activation
/// come free from Flutter's default shortcuts once the widget is focusable.
/// [builder] gets `focused`, which is only true in keyboard/D-pad highlight
/// mode, so touch users never see a ring; TV users get the web's hover ring.
class Pressable extends StatefulWidget {
  const Pressable({
    super.key,
    required this.builder,
    this.onTap,
    this.onLongPress,
    this.autofocus = false,
    this.pressedScale = 0.96,
    this.semanticLabel,
  });

  final Widget Function(BuildContext context, bool focused) builder;
  final VoidCallback? onTap;
  final VoidCallback? onLongPress;
  final bool autofocus;
  final double pressedScale;
  final String? semanticLabel;

  @override
  State<Pressable> createState() => _PressableState();
}

class _PressableState extends State<Pressable> {
  bool _pressed = false;
  bool _focused = false;

  void _tap() {
    HapticFeedback.selectionClick();
    widget.onTap?.call();
  }

  void _longPress() {
    HapticFeedback.mediumImpact();
    widget.onLongPress?.call();
  }

  @override
  Widget build(BuildContext context) {
    final enabled = widget.onTap != null || widget.onLongPress != null;
    return Semantics(
      button: true,
      enabled: enabled,
      label: widget.semanticLabel,
      child: FocusableActionDetector(
        enabled: enabled,
        autofocus: widget.autofocus,
        mouseCursor: enabled ? SystemMouseCursors.click : MouseCursor.defer,
        onShowFocusHighlight: (v) => setState(() => _focused = v),
        // ensureVisible: a D-pad step onto an off-screen tile scrolls it in.
        onFocusChange: (v) {
          if (v) Scrollable.ensureVisible(context, alignment: 0.5, duration: const Duration(milliseconds: 220), curve: HokagoMotion.smooth);
        },
        actions: {
          ActivateIntent: CallbackAction<ActivateIntent>(onInvoke: (_) {
            if (widget.onTap != null) _tap();
            return null;
          }),
        },
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTapDown: enabled ? (_) => setState(() => _pressed = true) : null,
          onTapUp: enabled ? (_) => setState(() => _pressed = false) : null,
          onTapCancel: enabled ? () => setState(() => _pressed = false) : null,
          onTap: widget.onTap != null ? _tap : null,
          onLongPress: widget.onLongPress != null ? _longPress : null,
          child: AnimatedScale(
            scale: _pressed ? widget.pressedScale : (_focused ? 1.04 : 1.0),
            duration: const Duration(milliseconds: 180),
            curve: HokagoMotion.snap,
            child: widget.builder(context, _focused),
          ),
        ),
      ),
    );
  }
}
