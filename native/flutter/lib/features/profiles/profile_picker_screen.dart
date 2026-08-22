import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/session/session_controller.dart';
import '../../core/session/session_state.dart';
import '../../core/theme/app_theme.dart';

/// "Who's watching" — shown when an account has more than one profile.
/// Mirrors the web's profile concept (profile.ts / TvAccountsView's account
/// switcher intent), surfaced once up front on mobile rather than a
/// persistent switcher affordance.
class ProfilePickerScreen extends ConsumerWidget {
  const ProfilePickerScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final profiles = ref.watch(sessionProvider).profiles;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 480),
            child: Padding(
              padding: const EdgeInsets.all(28),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text("Who's watching?", style: HokagoText.title),
                  const SizedBox(height: 28),
                  Wrap(
                    spacing: 20,
                    runSpacing: 20,
                    alignment: WrapAlignment.center,
                    children: [
                      for (final p in profiles)
                        _ProfileTile(profile: p, onTap: () => ref.read(sessionProvider.notifier).selectProfile(p)),
                    ],
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

class _ProfileTile extends StatelessWidget {
  const _ProfileTile({required this.profile, required this.onTap});
  final ProfileOption profile;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final initial = profile.name.isNotEmpty ? profile.name[0].toUpperCase() : '?';
    return GestureDetector(
      onTap: onTap,
      child: Column(
        children: [
          Container(
            width: 84,
            height: 84,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(22),
              gradient: const LinearGradient(colors: [HokagoColors.wiiBtnTop, HokagoColors.wiiBtnBottom]),
              boxShadow: hokagoPanelShadow,
            ),
            alignment: Alignment.center,
            child: Text(initial, style: const TextStyle(fontFamily: 'Zen Maru Gothic', fontSize: 32, fontWeight: FontWeight.w700, color: Colors.white)),
          ),
          const SizedBox(height: 10),
          Text(profile.name, style: HokagoText.cardTitle),
        ],
      ),
    );
  }
}
