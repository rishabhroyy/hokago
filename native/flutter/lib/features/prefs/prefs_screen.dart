import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:package_info_plus/package_info_plus.dart';

import '../../core/platform.dart';
import '../../core/session/session_controller.dart';
import '../../core/theme/app_theme.dart';
import '../../core/theme/hue.dart';
import '../../core/widgets/hokago_icon.dart';
import '../../core/widgets/hokago_panel.dart';
import '../../core/widgets/media_tile.dart';
import '../../core/widgets/pressable.dart';
import '../../core/widgets/wii_button.dart';
import '../common/states.dart';

final _versionProvider = FutureProvider((ref) => PackageInfo.fromPlatform());

/// PrefsView.tsx's account settings (display name, password) plus what a
/// native client owns: profile switching, devices, approving a TV, the
/// server connection, sign out.
class PrefsScreen extends ConsumerWidget {
  const PrefsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(sessionProvider);
    final notifier = ref.read(sessionProvider.notifier);
    final gutter = pageGutter(context);
    final version = ref.watch(_versionProvider).value;
    final host = Uri.tryParse(session.serverUrl ?? '')?.host ?? '—';

    return Scaffold(
      body: ListView(
        padding: EdgeInsets.fromLTRB(gutter, MediaQuery.paddingOf(context).top + 28, gutter, MediaQuery.paddingOf(context).bottom + 32),
        children: [
          const PageHeader('Settings'),
          const SizedBox(height: 24),
          Center(
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 640),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _ProfileCard(name: session.profileName ?? 'Profile', id: session.profileId ?? '?'),
                  const SizedBox(height: 28),
                  _Group(title: 'Profile', rows: [
                    if (session.profileId != null)
                      _Row(icon: 'edit', title: 'Display name', sub: session.profileName, onTap: () => _rename(context, ref, session.profileId!, session.profileName ?? '')),
                    if (session.profiles.length > 1)
                      _Row(icon: 'users', title: 'Switch profile', sub: '${session.profiles.length} profiles on this account', onTap: notifier.switchProfile),
                  ]),
                  _Group(title: 'Account', rows: [
                    _Row(icon: 'key', title: 'Change password', onTap: () => _changePassword(context, ref)),
                    _Row(icon: 'monitor', title: 'Devices', sub: 'See and sign out devices on this account', onTap: () => context.push('/devices')),
                    if (!isTvBuild) _Row(icon: 'tv', title: 'Approve a TV or device', sub: 'Sign in a TV with the code it shows', onTap: () => context.push('/approve')),
                  ]),
                  _Group(title: 'Watch together', rows: [
                    _Row(icon: 'ticket', title: 'Join a watch party', sub: 'Enter an invite code', onTap: () => context.push('/party')),
                  ]),
                  _Group(title: 'Server', rows: [
                    _Row(icon: 'disk', title: host, sub: session.serverUrl),
                    _Row(icon: 'refresh', title: 'Use a different server', onTap: () => _confirm(context, 'Switch servers?', 'You\'ll be signed out of $host.', notifier.changeServer)),
                  ]),
                  const SizedBox(height: 8),
                  Center(
                    child: WiiButton.ghost(
                      icon: 'back',
                      label: 'Sign out',
                      onPressed: () => _confirm(context, 'Sign out?', 'Downloads stay on this device.', notifier.logout),
                    ),
                  ),
                  const SizedBox(height: 24),
                  Text(version != null ? 'hokago ${version.version} (${version.buildNumber})' : ' ', textAlign: TextAlign.center, style: HokagoText.small),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Future<void> _confirm(BuildContext context, String title, String body, Future<void> Function() action) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        title: Text(title),
        content: Text(body),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(d, true), child: Text(title.replaceAll('?', ''), style: const TextStyle(color: HokagoColors.accent))),
        ],
      ),
    );
    if (ok == true) await action();
  }

  Future<void> _rename(BuildContext context, WidgetRef ref, String id, String current) async {
    final controller = TextEditingController(text: current);
    final name = await showDialog<String>(
      context: context,
      builder: (d) => AlertDialog(
        title: const Text('Display name'),
        content: TextField(controller: controller, autofocus: true, maxLength: 40, onSubmitted: (v) => Navigator.pop(d, v)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(d, controller.text), child: const Text('Save')),
        ],
      ),
    );
    controller.dispose();
    final trimmed = name?.trim() ?? '';
    if (trimmed.isEmpty || trimmed == current) return;
    try {
      await ref.read(sessionProvider.notifier).api.renameProfile(id, trimmed);
      ref.read(sessionProvider.notifier).renamedProfile(id, trimmed);
    } catch (_) {
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("Couldn't save the name")));
    }
  }

  Future<void> _changePassword(BuildContext context, WidgetRef ref) async {
    final current = TextEditingController(), next = TextEditingController();
    final messenger = ScaffoldMessenger.of(context);
    final ok = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        title: const Text('Change password'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: current, obscureText: true, autofocus: true, decoration: const InputDecoration(labelText: 'Current password')),
          const SizedBox(height: 12),
          TextField(controller: next, obscureText: true, decoration: const InputDecoration(labelText: 'New password')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(d, true), child: const Text('Change')),
        ],
      ),
    );
    final (cur, nxt) = (current.text, next.text);
    current.dispose();
    next.dispose();
    if (ok != true || nxt.isEmpty) return;
    try {
      await ref.read(sessionProvider.notifier).api.changePassword(currentPassword: cur, newPassword: nxt);
      messenger.showSnackBar(const SnackBar(content: Text('Password changed')));
    } catch (_) {
      messenger.showSnackBar(const SnackBar(content: Text("That current password didn't match")));
    }
  }
}

class _ProfileCard extends StatelessWidget {
  const _ProfileCard({required this.name, required this.id});
  final String name;
  final String id;

  @override
  Widget build(BuildContext context) {
    return HokagoPanel(
      borderRadius: 28,
      padding: const EdgeInsets.all(18),
      child: Row(children: [
        Container(
          width: 64,
          height: 64,
          decoration: BoxDecoration(borderRadius: BorderRadius.circular(20), gradient: LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: hueFor(id))),
          alignment: Alignment.center,
          child: Text(name.isNotEmpty ? name.characters.first.toUpperCase() : '?', style: HokagoText.title.copyWith(color: Colors.white)),
        ),
        const SizedBox(width: 16),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(name, style: HokagoText.section),
            const SizedBox(height: 2),
            const Text('Watching on this device', style: HokagoText.small),
          ]),
        ),
      ]),
    );
  }
}

class _Group extends StatelessWidget {
  const _Group({required this.title, required this.rows});
  final String title;
  final List<_Row> rows;

  @override
  Widget build(BuildContext context) {
    if (rows.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: 24),
      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
        Padding(padding: const EdgeInsets.only(left: 6, bottom: 10), child: Text(title, style: HokagoText.meta.copyWith(color: HokagoColors.ink3, fontWeight: FontWeight.w700))),
        HokagoPanel(
          borderRadius: 24,
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Column(children: [
            for (var i = 0; i < rows.length; i++) ...[
              if (i > 0) const Divider(indent: 58, height: 1),
              rows[i],
            ],
          ]),
        ),
      ]),
    );
  }
}

class _Row extends StatelessWidget {
  const _Row({required this.icon, required this.title, this.sub, this.onTap});
  final String icon;
  final String title;
  final String? sub;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    return Pressable(
      onTap: onTap,
      pressedScale: 0.98,
      semanticLabel: title,
      builder: (context, focused) => AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        margin: const EdgeInsets.symmetric(horizontal: 6),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(18),
          color: focused ? HokagoColors.wii.withValues(alpha: 0.12) : Colors.transparent,
          border: Border.all(color: focused ? HokagoColors.wii : Colors.transparent, width: 2),
        ),
        child: Row(children: [
          Container(
            width: 32,
            height: 32,
            decoration: BoxDecoration(color: HokagoColors.wii.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(10)),
            alignment: Alignment.center,
            child: HokagoIcon(icon, size: 17, color: HokagoColors.wiiInk),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(title, style: HokagoText.cardTitle.copyWith(fontSize: 14.5), maxLines: 1, overflow: TextOverflow.ellipsis),
              if (sub != null) Text(sub!, style: HokagoText.small, maxLines: 1, overflow: TextOverflow.ellipsis),
            ]),
          ),
          if (onTap != null) Transform.rotate(angle: 3.14159, child: const HokagoIcon('back', size: 14, color: HokagoColors.ink3)),
        ]),
      ),
    );
  }
}
