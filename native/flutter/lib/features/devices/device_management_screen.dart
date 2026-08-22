import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/models/auth.dart';
import '../../core/api/token_store.dart';
import '../../core/session/session_controller.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/hokago_panel.dart';

final devicesProvider = FutureProvider.autoDispose((ref) => ref.read(sessionProvider.notifier).api.devices());

IconData _iconFor(String platform) {
  switch (platform) {
    case 'IOS':
    case 'IPADOS':
      return Icons.phone_iphone_rounded;
    case 'ANDROID':
      return Icons.phone_android_rounded;
    case 'ANDROIDTV':
    case 'GOOGLETV':
    case 'TVOS':
      return Icons.tv_rounded;
    case 'MACOS':
    case 'WINDOWS':
    case 'LINUX':
      return Icons.laptop_mac_rounded;
    default:
      return Icons.device_unknown_rounded;
  }
}

class DeviceManagementScreen extends ConsumerWidget {
  const DeviceManagementScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final devices = ref.watch(devicesProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Devices')),
      body: FutureBuilder<String?>(
        future: TokenStore.instance.deviceId,
        builder: (context, thisDeviceSnap) {
          final thisDeviceId = thisDeviceSnap.data;
          return devices.when(
            loading: () => const Center(child: CircularProgressIndicator()),
            error: (e, _) => Center(child: Text('$e', style: HokagoText.meta)),
            data: (items) => ListView.separated(
              padding: const EdgeInsets.all(16),
              itemCount: items.length,
              separatorBuilder: (_, __) => const SizedBox(height: 12),
              itemBuilder: (_, i) {
                final d = items[i];
                final isThisDevice = d.id == thisDeviceId;
                return HokagoPanel(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                  child: ListTile(
                    contentPadding: EdgeInsets.zero,
                    leading: Icon(_iconFor(d.platform), color: HokagoColors.wiiDeep),
                    title: Text(d.name, style: HokagoText.cardTitle),
                    subtitle: Text(
                      isThisDevice ? 'This device' : (d.lastSeenAt != null ? 'Last seen ${_relative(d.lastSeenAt!)}' : 'Never seen'),
                      style: HokagoText.meta,
                    ),
                    trailing: IconButton(
                      icon: Icon(Icons.delete_outline_rounded, color: HokagoColors.ink3),
                      onPressed: () async {
                        await ref.read(sessionProvider.notifier).api.deleteDevice(d.id);
                        ref.invalidate(devicesProvider);
                        if (isThisDevice) ref.read(sessionProvider.notifier).logout();
                      },
                    ),
                  ),
                );
              },
            ),
          );
        },
      ),
    );
  }
}

String _relative(DateTime t) {
  final diff = DateTime.now().difference(t);
  if (diff.inMinutes < 1) return 'just now';
  if (diff.inHours < 1) return '${diff.inMinutes}m ago';
  if (diff.inDays < 1) return '${diff.inHours}h ago';
  return '${diff.inDays}d ago';
}
