import 'package:flutter/material.dart';

/// app.css's `.dark .skeleton`: a soft sweeping shimmer instead of a spinner.
/// One controller per [SkeletonScope]; every [Skeleton] under it shares the
/// sweep so a whole loading page shimmers in sync.
class SkeletonScope extends StatefulWidget {
  const SkeletonScope({super.key, required this.child});
  final Widget child;

  @override
  State<SkeletonScope> createState() => _SkeletonScopeState();
}

class _SkeletonScopeState extends State<SkeletonScope> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1500))..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => _Sweep(animation: _c, child: widget.child);
}

class _Sweep extends InheritedWidget {
  const _Sweep({required this.animation, required super.child});
  final Animation<double> animation;
  @override
  bool updateShouldNotify(_Sweep old) => old.animation != animation;
}

class Skeleton extends StatelessWidget {
  const Skeleton({super.key, this.width, this.height, this.radius = 999, this.aspectRatio});
  final double? width, height;
  final double radius;
  final double? aspectRatio;

  @override
  Widget build(BuildContext context) {
    final sweep = context.dependOnInheritedWidgetOfExactType<_Sweep>()?.animation ?? const AlwaysStoppedAnimation(0.5);
    Widget box = AnimatedBuilder(
      animation: sweep,
      builder: (_, _) {
        final t = sweep.value * 3 - 1; // -1 → 2 across the box
        return DecoratedBox(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(radius),
            gradient: LinearGradient(
              begin: Alignment(-1 + t, 0),
              end: Alignment(t, 0),
              colors: const [Color(0xFF26221D), Color(0xFF2E2A24), Color(0xFF26221D)],
            ),
          ),
          child: SizedBox(width: width, height: height),
        );
      },
    );
    if (aspectRatio != null) box = AspectRatio(aspectRatio: aspectRatio!, child: box);
    return RepaintBoundary(child: box);
  }
}
