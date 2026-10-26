import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/token_store.dart';
import '../../core/session/session_controller.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/hokago_icon.dart';
import '../../core/widgets/hokago_panel.dart';
import '../../core/widgets/media_tile.dart';
import '../../core/widgets/skeleton.dart';
import '../../core/widgets/wii_button.dart';
import '../common/states.dart';

final devicesProvider = FutureProvider.autoDispose((ref) => ref.read(sessionProvider.notifier).api.devices());
final _thisDeviceProvider = FutureProvider.autoDispose((ref) => TokenStore.instance.deviceId);

String _iconFor(String platform) => switch (platform) {
      'ANDROIDTV' || 'GOOGLETV' || 'TVOS' => 'tv',
      'MACOS' || 'WINDOWS' || 'LINUX' => 'monitor',
      _ => 'disk',
    };

String _relative(DateTime t) {
  final diff = DateTime.now().difference(t);
  if (diff.inMinutes < 1) return 'just now';
  if (diff.inHours < 1) return '${diff.inMinutes}m ago';
  if (diff.inDays < 1) return '${diff.inHours}h ago';
  return '${diff.inDays}d ago';
}

class DeviceManagementScreen extends ConsumerWidget {
  const DeviceManagementScreen({super.key});

  Future<void> _signOut(BuildContext context, WidgetRef ref, String id, String name, bool isThis) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (d) => AlertDialog(
        title: Text('Sign out $name?'),
        content: Text(isThis ? 'This is the device you are using.' : 'It will need to sign in again.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(d, false), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.pop(d, true), child: const Text('Sign out', style: TextStyle(color: HokagoColors.accent))),
        ],
      ),
    );
    if (ok != true) return;
    try {
      await ref.read(sessionProvider.notifier).api.deleteDevice(id);
      ref.invalidate(devicesProvider);
      if (isThis) await ref.read(sessionProvider.notifier).logout();
    } catch (_) {
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text("Couldn't sign that device out")));
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final devices = ref.watch(devicesProvider);
    final thisId = ref.watch(_thisDeviceProvider).value;
    final gutter = pageGutter(context);
    return Scaffold(
      body: ListView(
        padding: EdgeInsets.fromLTRB(gutter, MediaQuery.paddingOf(context).top + 16, gutter, MediaQuery.paddingOf(context).bottom + 24),
        children: [
          Align(alignment: Alignment.centerLeft, child: WiiButton.ghost(compact: true, icon: 'back', label: 'Back', onPressed: () => context.pop())),
          const SizedBox(height: 16),
          PageHeader('Devices', count: devices.value?.length),
          const SizedBox(height: 20),
          ...switch (devices) {
            AsyncData(:final value) => [
                for (final d in value)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 12),
                    child: HokagoPanel(
                      borderRadius: 22,
                      padding: const EdgeInsets.fromLTRB(16, 10, 8, 10),
                      child: Row(children: [
                        Container(
                          width: 40,
                          height: 40,
                          decoration: BoxDecoration(color: HokagoColors.wii.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(12)),
                          alignment: Alignment.center,
                          child: HokagoIcon(_iconFor(d.platform), size: 20, color: HokagoColors.wiiInk),
                        ),
                        const SizedBox(width: 14),
                        Expanded(
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Text(d.name, style: HokagoText.cardTitle.copyWith(fontSize: 14.5)),
                            Text(
                              d.id == thisId ? 'This device' : (d.lastSeenAt != null ? 'Last seen ${_relative(d.lastSeenAt!)}' : 'Never seen'),
                              style: HokagoText.small.copyWith(color: d.id == thisId ? HokagoColors.wiiInk : HokagoColors.ink3),
                            ),
                          ]),
                        ),
                        IconButton(
                          tooltip: 'Sign out',
                          icon: const HokagoIcon('trash', size: 18, color: HokagoColors.ink3),
                          onPressed: () => _signOut(context, ref, d.id, d.name, d.id == thisId),
                        ),
                      ]),
                    ),
                  ),
              ],
            AsyncError() => [
                MessageState(icon: 'wifi-off', title: "Can't load devices", message: 'Check your connection.', actionLabel: 'Try again', onAction: () => ref.invalidate(devicesProvider)),
              ],
            _ => [SkeletonScope(child: Column(children: [for (var i = 0; i < 3; i++) const Padding(padding: EdgeInsets.only(bottom: 12), child: Skeleton(height: 64, radius: 22))]))],
          },
        ],
      ),
    );
  }
}
