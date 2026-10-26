import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:media_kit/media_kit.dart';

import '../../core/theme/app_theme.dart';
import '../../core/widgets/hokago_icon.dart';
import '../../core/widgets/pressable.dart';

const _hideAfter = Duration(milliseconds: 3500);
const seekStepMs = 10000;

String formatClock(int ms) {
  final s = (ms / 1000).floor().clamp(0, 1 << 31);
  final h = s ~/ 3600, m = (s % 3600) ~/ 60, sec = s % 60;
  final mm = h > 0 ? m.toString().padLeft(2, '0') : '$m';
  return h > 0 ? '$h:$mm:${sec.toString().padLeft(2, '0')}' : '$mm:${sec.toString().padLeft(2, '0')}';
}

/// Everything drawn over the video, shared by streaming and offline playback.
/// Timeline math stays with the caller: [offsetMs] maps the player's local
/// clock onto the title's absolute timeline (a TRANSCODE/REMUX restart
/// starts its stream mid-file), and seeks are reported as absolute ms.
///
/// Touch: tap toggles the chrome, double-tap a side seeks ±10s. Keyboard /
/// D-pad / media keys: any key wakes the chrome, select/space/play-pause
/// toggles, left/right/rewind/fast-forward seek. Auto-hides while playing.
class PlayerChrome extends StatefulWidget {
  const PlayerChrome({
    super.key,
    required this.player,
    required this.title,
    required this.offsetMs,
    required this.durationMs,
    required this.onSeek,
    required this.onBack,
    this.subtitle,
    this.onTogglePlay,
    this.actions = const [],
    this.locked = false,
    this.busy = false,
    this.previewBuilder,
    this.overlay,
  });

  final Player player;
  final String title;
  final String? subtitle;
  final int offsetMs;

  /// Absolute duration; 0 = use the player's own.
  final int durationMs;
  final void Function(int absoluteMs) onSeek;
  final VoidCallback onBack;

  /// Defaults to player.playOrPause; the party host wraps it to broadcast.
  final VoidCallback? onTogglePlay;
  final List<Widget> actions;

  /// A party guest: the host owns play/pause/seek.
  final bool locked;

  /// A server-side restart (seek / quality / audio) is in flight.
  final bool busy;

  /// Scrubber preview (trickplay) for an absolute position.
  final Widget? Function(int absoluteMs)? previewBuilder;

  /// Up-next card etc., drawn above the chrome.
  final Widget? overlay;

  @override
  State<PlayerChrome> createState() => _PlayerChromeState();
}

class _PlayerChromeState extends State<PlayerChrome> {
  bool _visible = true;
  Timer? _hide;
  final _focus = FocusNode(debugLabel: 'player');
  ({bool forward, int key})? _bump;
  late final StreamSubscription<bool> _playingSub;

  Player get _p => widget.player;
  int get _durMs => widget.durationMs > 0 ? widget.durationMs : _p.state.duration.inMilliseconds + widget.offsetMs;
  int get _posMs => _p.state.position.inMilliseconds + widget.offsetMs;

  @override
  void initState() {
    super.initState();
    _playingSub = _p.stream.playing.listen((playing) => playing ? _scheduleHide() : _show(stay: true));
    _scheduleHide();
  }

  @override
  void dispose() {
    _hide?.cancel();
    _playingSub.cancel();
    _focus.dispose();
    super.dispose();
  }

  void _scheduleHide() {
    _hide?.cancel();
    _hide = Timer(_hideAfter, () {
      if (mounted && _p.state.playing) setState(() => _visible = false);
    });
  }

  void _show({bool stay = false}) {
    if (!_visible) setState(() => _visible = true);
    stay ? _hide?.cancel() : _scheduleHide();
  }

  void _toggle() {
    if (widget.locked) return;
    (widget.onTogglePlay ?? _p.playOrPause)();
    _show();
  }

  void _seekBy(int deltaMs) {
    if (widget.locked) return;
    final target = (_posMs + deltaMs).clamp(0, _durMs > 0 ? _durMs : 1 << 31);
    widget.onSeek(target);
    setState(() => _bump = (forward: deltaMs > 0, key: DateTime.now().millisecondsSinceEpoch));
    _show();
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent e) {
    if (e is! KeyDownEvent && e is! KeyRepeatEvent) return KeyEventResult.ignored;
    final k = e.logicalKey;
    if (k == LogicalKeyboardKey.mediaPlayPause || k == LogicalKeyboardKey.mediaPlay || k == LogicalKeyboardKey.mediaPause || k == LogicalKeyboardKey.space) {
      _toggle();
      return KeyEventResult.handled;
    }
    if (k == LogicalKeyboardKey.mediaFastForward || k == LogicalKeyboardKey.mediaSkipForward) {
      _seekBy(seekStepMs * 3);
      return KeyEventResult.handled;
    }
    if (k == LogicalKeyboardKey.mediaRewind || k == LogicalKeyboardKey.mediaSkipBackward) {
      _seekBy(-seekStepMs * 3);
      return KeyEventResult.handled;
    }
    // Chrome hidden: the D-pad drives playback directly; the first press of
    // anything else just wakes the chrome (then focus traversal takes over).
    if (!_visible) {
      if (k == LogicalKeyboardKey.arrowLeft) {
        _seekBy(-seekStepMs);
      } else if (k == LogicalKeyboardKey.arrowRight) {
        _seekBy(seekStepMs);
      } else if (k == LogicalKeyboardKey.select || k == LogicalKeyboardKey.enter) {
        _toggle();
      } else if (k != LogicalKeyboardKey.escape && k != LogicalKeyboardKey.goBack) {
        _show();
      } else {
        return KeyEventResult.ignored;
      }
      return KeyEventResult.handled;
    }
    _show();
    return KeyEventResult.ignored;
  }

  @override
  Widget build(BuildContext context) {
    final padding = MediaQuery.paddingOf(context);
    return Focus(
      focusNode: _focus,
      autofocus: true,
      onKeyEvent: _onKey,
      child: Stack(
        fit: StackFit.expand,
        children: [
          // gesture layer: thirds — double-tap the sides to seek, tap anywhere to toggle
          Row(children: [
            for (final side in const [-1, 0, 1])
              Expanded(
                child: GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTap: () => _visible ? setState(() => _visible = false) : _show(),
                  onDoubleTap: side == 0 ? _toggle : () => _seekBy(side * seekStepMs),
                ),
              ),
          ]),
          StreamBuilder<bool>(
            stream: _p.stream.buffering,
            initialData: _p.state.buffering,
            builder: (_, snap) => (snap.data ?? false) || widget.busy
                ? const IgnorePointer(child: Center(child: SizedBox(width: 44, height: 44, child: CircularProgressIndicator(strokeWidth: 3, color: Colors.white))))
                : const SizedBox.shrink(),
          ),
          if (_bump != null) _SeekBump(key: ValueKey(_bump!.key), forward: _bump!.forward),
          IgnorePointer(
            ignoring: !_visible,
            child: AnimatedOpacity(
              opacity: _visible ? 1 : 0,
              duration: const Duration(milliseconds: 220),
              curve: HokagoMotion.smooth,
              child: Stack(
                fit: StackFit.expand,
                children: [
                  const IgnorePointer(
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        gradient: LinearGradient(
                          begin: Alignment.topCenter,
                          end: Alignment.bottomCenter,
                          colors: [Color(0x99000000), Color(0x00000000), Color(0x00000000), Color(0xCC000000)],
                          stops: [0, 0.28, 0.55, 1],
                        ),
                      ),
                    ),
                  ),
                  // top: back, title, actions
                  Positioned(
                    left: 12 + padding.left,
                    right: 12 + padding.right,
                    top: 8 + padding.top,
                    child: Row(children: [
                      _ChromeButton(icon: 'back', label: 'Back', onTap: widget.onBack),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                          Text(widget.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: HokagoText.section.copyWith(fontSize: 18, color: Colors.white)),
                          if (widget.subtitle != null)
                            Text(widget.subtitle!, maxLines: 1, overflow: TextOverflow.ellipsis, style: HokagoText.small.copyWith(color: Colors.white70)),
                        ]),
                      ),
                      ...widget.actions,
                    ]),
                  ),
                  // center transport
                  Center(
                    child: Opacity(
                      opacity: widget.locked ? 0.4 : 1,
                      child: Row(mainAxisSize: MainAxisSize.min, children: [
                        _ChromeButton(icon: 'back', label: 'Back 10 seconds', badge: '10', size: 56, onTap: widget.locked ? null : () => _seekBy(-seekStepMs)),
                        const SizedBox(width: 28),
                        StreamBuilder<bool>(
                          stream: _p.stream.playing,
                          initialData: _p.state.playing,
                          builder: (_, snap) => _ChromeButton(
                            icon: snap.data == true ? 'pause' : 'play',
                            label: snap.data == true ? 'Pause' : 'Play',
                            size: 76,
                            primary: true,
                            autofocus: true,
                            onTap: widget.locked ? null : _toggle,
                          ),
                        ),
                        const SizedBox(width: 28),
                        _ChromeButton(icon: 'back', label: 'Forward 10 seconds', badge: '10', mirror: true, size: 56, onTap: widget.locked ? null : () => _seekBy(seekStepMs)),
                      ]),
                    ),
                  ),
                  // bottom: scrubber
                  Positioned(
                    left: 20 + padding.left,
                    right: 20 + padding.right,
                    bottom: 14 + (padding.bottom > 0 ? padding.bottom : 8),
                    child: StreamBuilder<Duration>(
                      stream: _p.stream.position,
                      initialData: _p.state.position,
                      builder: (_, _) => WiiScrubber(
                        positionMs: _posMs,
                        bufferedMs: _p.state.buffer.inMilliseconds + widget.offsetMs,
                        durationMs: _durMs,
                        enabled: !widget.locked,
                        previewBuilder: widget.previewBuilder,
                        onScrubbing: (s) => s ? _show(stay: true) : _scheduleHide(),
                        onSeek: widget.onSeek,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
          ?widget.overlay,
        ],
      ),
    );
  }
}

class _ChromeButton extends StatelessWidget {
  const _ChromeButton({required this.icon, required this.label, required this.onTap, this.size = 44, this.primary = false, this.badge, this.mirror = false, this.autofocus = false});
  final String icon;
  final String label;
  final VoidCallback? onTap;
  final double size;
  final bool primary;
  final String? badge;
  final bool mirror;
  final bool autofocus;

  @override
  Widget build(BuildContext context) {
    return Pressable(
      onTap: onTap,
      autofocus: autofocus,
      pressedScale: 0.86,
      semanticLabel: label,
      builder: (context, focused) {
        Widget glyph = HokagoIcon(icon, size: size * (primary ? 0.4 : 0.36), color: Colors.white);
        if (mirror) glyph = Transform.flip(flipX: true, child: glyph);
        return AnimatedContainer(
          duration: const Duration(milliseconds: 160),
          width: size,
          height: size,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            gradient: primary ? const LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [HokagoColors.wiiBtnTop, HokagoColors.wiiBtnBottom]) : null,
            color: primary ? null : Colors.white.withValues(alpha: focused ? 0.22 : 0.1),
            boxShadow: focused
                ? hokagoWiiRing
                : primary
                    ? const [BoxShadow(color: Color(0xA62E9BC4), blurRadius: 22, spreadRadius: -6, offset: Offset(0, 6))]
                    : null,
          ),
          child: Stack(alignment: Alignment.center, children: [
            Padding(padding: EdgeInsets.only(left: icon == 'play' ? size * 0.06 : 0), child: glyph),
            if (badge != null) Positioned(bottom: size * 0.16, child: Text(badge!, style: HokagoText.kicker.copyWith(fontSize: 9, color: Colors.white))),
          ]),
        );
      },
    );
  }
}

/// The ±10s ripple that confirms a double-tap / D-pad seek.
class _SeekBump extends StatefulWidget {
  const _SeekBump({super.key, required this.forward});
  final bool forward;
  @override
  State<_SeekBump> createState() => _SeekBumpState();
}

class _SeekBumpState extends State<_SeekBump> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 650))..forward();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: Align(
        alignment: Alignment(widget.forward ? 0.62 : -0.62, 0),
        child: AnimatedBuilder(
          animation: _c,
          builder: (_, _) => Opacity(
            opacity: (1 - _c.value).clamp(0, 1),
            child: Transform.scale(
              scale: 0.85 + 0.25 * Curves.easeOut.transform(_c.value),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 10),
                decoration: BoxDecoration(color: Colors.black.withValues(alpha: 0.45), borderRadius: BorderRadius.circular(HokagoRadii.pill)),
                child: Text(widget.forward ? '+10s' : '−10s', style: HokagoText.section.copyWith(color: Colors.white, fontSize: 18)),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The Wii scrubber: glowing blue played track over a soft buffered track,
/// a white thumb that swells while dragging, the trickplay frame above it.
/// Seeks only on release (a TRANSCODE seek restarts the server's encode).
class WiiScrubber extends StatefulWidget {
  const WiiScrubber({
    super.key,
    required this.positionMs,
    required this.bufferedMs,
    required this.durationMs,
    required this.onSeek,
    this.enabled = true,
    this.previewBuilder,
    this.onScrubbing,
  });

  final int positionMs, bufferedMs, durationMs;
  final void Function(int absoluteMs) onSeek;
  final bool enabled;
  final Widget? Function(int absoluteMs)? previewBuilder;
  final void Function(bool scrubbing)? onScrubbing;

  @override
  State<WiiScrubber> createState() => _WiiScrubberState();
}

class _WiiScrubberState extends State<WiiScrubber> {
  double? _drag;

  double _ratio(int ms) => widget.durationMs > 0 ? (ms / widget.durationMs).clamp(0.0, 1.0) : 0.0;

  void _update(double dx, double width) => setState(() => _drag = (dx / width).clamp(0.0, 1.0));

  void _end() {
    final r = _drag;
    if (r == null) return;
    setState(() => _drag = null);
    widget.onScrubbing?.call(false);
    widget.onSeek((r * widget.durationMs).round());
  }

  @override
  Widget build(BuildContext context) {
    final shown = _drag ?? _ratio(widget.positionMs);
    final shownMs = (shown * widget.durationMs).round();
    return LayoutBuilder(builder: (context, c) {
      final w = c.maxWidth;
      final preview = _drag != null ? widget.previewBuilder?.call(shownMs) : null;
      return Column(mainAxisSize: MainAxisSize.min, children: [
        SizedBox(
          height: preview != null ? 110 : 0,
          child: preview == null
              ? null
              : Stack(clipBehavior: Clip.none, children: [
                  Positioned(
                    left: (shown * w - 80).clamp(0.0, (w - 160).clamp(0.0, double.infinity)),
                    bottom: 8,
                    child: Column(mainAxisSize: MainAxisSize.min, children: [
                      Container(
                        width: 160,
                        height: 90,
                        decoration: BoxDecoration(
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(color: Colors.white, width: 2),
                          boxShadow: const [BoxShadow(color: Color(0x99000000), blurRadius: 14)],
                        ),
                        child: ClipRRect(borderRadius: BorderRadius.circular(10), child: preview),
                      ),
                    ]),
                  ),
                ]),
        ),
        GestureDetector(
          behavior: HitTestBehavior.opaque,
          onHorizontalDragStart: widget.enabled
              ? (d) {
                  widget.onScrubbing?.call(true);
                  _update(d.localPosition.dx, w);
                }
              : null,
          onHorizontalDragUpdate: widget.enabled ? (d) => _update(d.localPosition.dx, w) : null,
          onHorizontalDragEnd: widget.enabled ? (_) => _end() : null,
          onTapDown: widget.enabled ? (d) => _update(d.localPosition.dx, w) : null,
          onTapUp: widget.enabled ? (_) => _end() : null,
          child: SizedBox(
            height: 32,
            child: CustomPaint(painter: _TrackPainter(played: shown, buffered: _ratio(widget.bufferedMs), dragging: _drag != null)),
          ),
        ),
        Row(children: [
          Text(formatClock(shownMs), style: HokagoText.small.copyWith(color: Colors.white, fontFeatures: const [FontFeature.tabularFigures()])),
          const Spacer(),
          Text(
            widget.durationMs > 0 ? '-${formatClock(widget.durationMs - shownMs)}' : '',
            style: HokagoText.small.copyWith(color: Colors.white70, fontFeatures: const [FontFeature.tabularFigures()]),
          ),
        ]),
      ]);
    });
  }
}

class _TrackPainter extends CustomPainter {
  _TrackPainter({required this.played, required this.buffered, required this.dragging});
  final double played, buffered;
  final bool dragging;

  @override
  void paint(Canvas canvas, Size size) {
    final h = dragging ? 8.0 : 5.0;
    final y = size.height / 2;
    RRect bar(double to) => RRect.fromLTRBR(0, y - h / 2, size.width * to, y + h / 2, Radius.circular(h));
    canvas.drawRRect(bar(1), Paint()..color = const Color(0x38FFFFFF));
    canvas.drawRRect(bar(buffered.clamp(played, 1)), Paint()..color = const Color(0x52FFFFFF));
    final playedRect = bar(played);
    canvas.drawRRect(
      playedRect,
      Paint()
        ..color = const Color(0xE64FB8E0)
        ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 5),
    );
    canvas.drawRRect(playedRect, Paint()..shader = const LinearGradient(colors: [HokagoColors.wii2, HokagoColors.wii]).createShader(playedRect.outerRect));
    final x = size.width * played;
    final r = dragging ? 10.0 : 7.0;
    if (dragging) canvas.drawCircle(Offset(x, y), r + 4, Paint()..color = const Color(0x664FB8E0));
    canvas.drawCircle(Offset(x, y), r, Paint()..color = Colors.white);
  }

  @override
  bool shouldRepaint(covariant _TrackPainter old) => old.played != played || old.buffered != buffered || old.dragging != dragging;
}
