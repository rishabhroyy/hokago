import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/session/session_controller.dart';
import '../../core/session/session_state.dart';
import '../../core/theme/app_theme.dart';
import '../../core/theme/hue.dart';
import '../../core/widgets/pressable.dart';

/// "Who's watching?" — shown when an account has more than one profile.
class ProfilePickerScreen extends ConsumerWidget {
  const ProfilePickerScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final profiles = ref.watch(sessionProvider.select((s) => s.profiles));
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(28),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Text("Who's watching?", style: HokagoText.title),
                const SizedBox(height: 32),
                Wrap(
                  spacing: 24,
                  runSpacing: 24,
                  alignment: WrapAlignment.center,
                  children: [
                    for (final (i, p) in profiles.indexed)
                      _ProfileTile(profile: p, autofocus: i == 0, onTap: () => ref.read(sessionProvider.notifier).selectProfile(p)),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ProfileTile extends StatelessWidget {
  const _ProfileTile({required this.profile, required this.onTap, this.autofocus = false});
  final ProfileOption profile;
  final VoidCallback onTap;
  final bool autofocus;

  @override
  Widget build(BuildContext context) {
    final initial = profile.name.isNotEmpty ? profile.name.characters.first.toUpperCase() : '?';
    return Pressable(
      onTap: onTap,
      autofocus: autofocus,
      semanticLabel: profile.name,
      builder: (context, focused) => Column(
        children: [
          AnimatedContainer(
            duration: const Duration(milliseconds: 200),
            width: 96,
            height: 96,
            padding: const EdgeInsets.all(5),
            decoration: BoxDecoration(color: HokagoColors.card, borderRadius: BorderRadius.circular(30), boxShadow: focused ? hokagoWiiRing : hokagoPanelShadow),
            child: DecoratedBox(
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(25),
                gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: hueFor(profile.id)),
              ),
              child: Center(
                child: Text(initial, style: HokagoText.title.copyWith(fontSize: 38, color: Colors.white, shadows: const [Shadow(color: Color(0x33000000), blurRadius: 6)])),
              ),
            ),
          ),
          const SizedBox(height: 12),
          Text(profile.name, style: HokagoText.cardTitle.copyWith(fontSize: 15, color: focused ? HokagoColors.wiiDeep : HokagoColors.ink)),
        ],
      ),
    );
  }
}
