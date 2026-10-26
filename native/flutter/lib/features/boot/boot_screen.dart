import 'package:flutter/material.dart';

import '../../core/widgets/hokago_icon.dart';

/// splash.ts's hopping mascot: the logo mark bobbing while the session boots
/// (server probe + token check). Replaces the old behavior of landing on an
/// empty Home before the API client existed.
class BootScreen extends StatefulWidget {
  const BootScreen({super.key});
  @override
  State<BootScreen> createState() => _BootScreenState();
}

class _BootScreenState extends State<BootScreen> with SingleTickerProviderStateMixin {
  late final AnimationController _hop = AnimationController(vsync: this, duration: const Duration(milliseconds: 900))..repeat();

  @override
  void dispose() {
    _hop.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: AnimatedBuilder(
          animation: _hop,
          builder: (context, child) {
            // a hop: up on a sine arc, a little squash on landing
            final t = _hop.value;
            final up = t < 0.6 ? Curves.easeOut.transform((t / 0.6)) : 1.0;
            final arc = t < 0.6 ? (1 - (2 * up - 1) * (2 * up - 1)) : 0.0;
            final squash = t >= 0.6 ? 1 - 0.08 * (1 - ((t - 0.6) / 0.4 - 0.5).abs() * 2) : 1.0;
            return Transform.translate(
              offset: Offset(0, -26 * arc),
              child: Transform(alignment: Alignment.bottomCenter, transform: Matrix4.diagonal3Values(2 - squash, squash, 1), child: child),
            );
          },
          child: const HokagoLogoMark(size: 72),
        ),
      ),
    );
  }
}
