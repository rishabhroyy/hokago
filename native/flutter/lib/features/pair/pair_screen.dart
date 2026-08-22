import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/token_store.dart';
import '../../core/platform.dart';
import '../../core/session/session_controller.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/hokago_panel.dart';

const _pollInterval = Duration(milliseconds: 3500); // stays under the 20/min rate limit

/// TV-style pairing — a device that can't type a password shows a code,
/// another already-logged-in client approves it. Mirrors apps/web's
/// PairView.tsx + the pair/request+status flow in auth.ts. The Android TV
/// flavor is the intended primary user of this screen, but it's reachable
/// from any client — nothing here is TV-gated.
class PairScreen extends ConsumerStatefulWidget {
  const PairScreen({super.key});
  @override
  ConsumerState<PairScreen> createState() => _PairScreenState();
}

class _PairScreenState extends ConsumerState<PairScreen> {
  String? _code;
  String? _error;
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    _requestCode();
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _requestCode() async {
    setState(() {
      _code = null;
      _error = null;
    });
    try {
      final api = ref.read(sessionProvider.notifier).api;
      final res = await api.pairRequest(name: 'hokago mobile', platform: currentDevicePlatform());
      if (!mounted) return;
      setState(() => _code = res.code);
      _poll?.cancel();
      _poll = Timer.periodic(_pollInterval, (_) => _checkStatus(res.pairingId));
    } catch (e) {
      if (mounted) setState(() => _error = 'Could not request a pairing code');
    }
  }

  Future<void> _checkStatus(String pairingId) async {
    try {
      final api = ref.read(sessionProvider.notifier).api;
      final status = await api.pairStatus(pairingId);
      if (!mounted) return;
      switch (status.status) {
        case 'COMPLETE':
          _poll?.cancel();
          if (status.accessToken != null && status.refreshToken != null) {
            await TokenStore.instance.setAccessToken(status.accessToken!);
            await TokenStore.instance.setRefreshToken(status.refreshToken!);
            await TokenStore.instance.setDeviceId(status.deviceId);
            await ref.read(sessionProvider.notifier).completePairing();
          }
          break;
        case 'EXPIRED':
          _poll?.cancel();
          if (mounted) setState(() => _error = 'Code expired');
          await Future.delayed(const Duration(seconds: 2));
          if (mounted) _requestCode();
          break;
        default:
        // PENDING/APPROVED — keep polling
      }
    } catch (_) {
      // transient — next poll tick tries again
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Pair this device')),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: HokagoPanel(
              padding: const EdgeInsets.all(32),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text('Enter this code on another device', style: HokagoText.section, textAlign: TextAlign.center),
                  const SizedBox(height: 8),
                  Text('Sign in on your phone or computer and approve this code under Pair a device.', style: HokagoText.meta, textAlign: TextAlign.center),
                  const SizedBox(height: 28),
                  if (_code != null)
                    Text(
                      _code!.split('').join(' '),
                      style: HokagoText.display.copyWith(fontSize: 40, letterSpacing: 6),
                    )
                  else if (_error == null)
                    const CircularProgressIndicator()
                  else
                    Text(_error!, style: const TextStyle(color: Colors.redAccent)),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
