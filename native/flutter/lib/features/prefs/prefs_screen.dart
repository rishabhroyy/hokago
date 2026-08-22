import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../../core/session/session_controller.dart';
import '../../core/theme/app_theme.dart';
import '../../core/theme/theme_mode_controller.dart';
import '../../core/widgets/hokago_panel.dart';
import '../devices/device_management_screen.dart';

/// Mirrors apps/web/src/views/PrefsView.tsx's role — account/appearance
/// settings: appearance (light/dark), profile switching, device management,
/// server/session info, sign out.
class PrefsScreen extends ConsumerWidget {
  const PrefsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final isDark = ref.watch(themeModeProvider);
    final session = ref.watch(sessionProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          _SectionLabel('Appearance'),
          const SizedBox(height: 8),
          HokagoPanel(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
            child: SwitchListTile(
              contentPadding: EdgeInsets.zero,
              title: Text('Dark mode', style: HokagoText.cardTitle),
              value: isDark,
              activeThumbColor: HokagoColors.wiiDeep,
              onChanged: (v) => ref.read(themeModeProvider.notifier).setDark(v),
            ),
          ),
          if (session.profiles.length > 1) ...[
            const SizedBox(height: 24),
            _SectionLabel('Profile'),
            const SizedBox(height: 8),
            HokagoPanel(
              padding: EdgeInsets.zero,
              child: ListTile(
                title: Text(session.profileName ?? '—', style: HokagoText.cardTitle),
                subtitle: Text('${session.profiles.length} profiles on this account', style: HokagoText.meta),
                trailing: Icon(Icons.swap_horiz_rounded, color: HokagoColors.ink3),
                onTap: () => ref.read(sessionProvider.notifier).switchProfile(),
              ),
            ),
          ],
          const SizedBox(height: 24),
          _SectionLabel('Devices'),
          const SizedBox(height: 8),
          HokagoPanel(
            padding: EdgeInsets.zero,
            child: ListTile(
              title: Text('Manage devices', style: HokagoText.cardTitle),
              subtitle: Text('See and revoke devices signed into this account', style: HokagoText.meta),
              trailing: Icon(Icons.chevron_right_rounded, color: HokagoColors.ink3),
              onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const DeviceManagementScreen())),
            ),
          ),
          const SizedBox(height: 24),
          _SectionLabel('Server'),
          const SizedBox(height: 8),
          HokagoPanel(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(session.serverUrl ?? '—', style: HokagoText.cardTitle),
                if (session.profileName != null) ...[
                  const SizedBox(height: 4),
                  Text('Profile: ${session.profileName}', style: HokagoText.meta),
                ],
              ],
            ),
          ),
          const SizedBox(height: 16),
          SizedBox(
            width: double.infinity,
            child: OutlinedButton(
              onPressed: () => ref.read(sessionProvider.notifier).logout(),
              child: const Text('Log out'),
            ),
          ),
          const SizedBox(height: 24),
          FutureBuilder<PackageInfo>(
            future: PackageInfo.fromPlatform(),
            builder: (context, snap) {
              final v = snap.data;
              return Center(
                child: Text(v != null ? 'hokago ${v.version} (${v.buildNumber})' : ' ', style: HokagoText.small),
              );
            },
          ),
        ],
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Text(text.toUpperCase(), style: HokagoText.kicker.copyWith(color: HokagoColors.ink3));
}
