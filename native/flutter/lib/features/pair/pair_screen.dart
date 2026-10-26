import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/token_store.dart';
import '../../core/platform.dart';
import '../../core/session/session_controller.dart';
import '../../core/theme/app_theme.dart';
import '../common/gate_card.dart';

const _pollInterval = Duration(milliseconds: 3500); // stays under the 20/min rate limit

/// TV-style pairing — a device that can't comfortably type a password shows
/// a code, another signed-in client approves it (ApprovePairScreen, or the
/// web's PairView). The TV flavor's front door; reachable from any login.
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
      final res = await api.pairRequest(name: currentDeviceName(), platform: currentDevicePlatform());
      if (!mounted) return;
      setState(() => _code = res.code);
      _poll?.cancel();
      _poll = Timer.periodic(_pollInterval, (_) => _checkStatus(res.pairingId));
    } catch (e) {
      if (mounted) setState(() => _error = "Couldn't get a code — check the server is reachable");
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
          if (mounted) setState(() => _error = 'Code expired — getting a new one…');
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
    final host = Uri.tryParse(ref.watch(sessionProvider.select((s) => s.serverUrl)) ?? '')?.host;
    return GateCard(
      title: 'Sign in with a code',
      subtitle: 'On a phone or computer already signed in, open Settings → Approve a TV or device and enter:',
      maxWidth: 480,
      children: [
        Container(
          padding: const EdgeInsets.symmetric(vertical: 22),
          decoration: BoxDecoration(color: HokagoColors.paper, borderRadius: BorderRadius.circular(24), border: Border.all(color: HokagoColors.line)),
          alignment: Alignment.center,
          child: _code != null
              ? Text(
                  _code!.split('').join(' '),
                  style: HokagoText.display.copyWith(fontSize: 44, letterSpacing: 4, color: HokagoColors.wiiInk, fontFeatures: const [FontFeature.tabularFigures()]),
                )
              : _error == null
                  ? const SizedBox(height: 46, child: Center(child: CircularProgressIndicator()))
                  : Text(_error!, style: HokagoText.meta.copyWith(color: HokagoColors.accent)),
        ),
        const SizedBox(height: 14),
        Text(host != null && host.isNotEmpty ? 'Waiting for approval on $host…' : 'Waiting for approval…', textAlign: TextAlign.center, style: HokagoText.small),
        const SizedBox(height: 18),
        if (context.canPop()) TextButton(autofocus: true, onPressed: () => context.pop(), child: const Text('Use a password instead')),
        TextButton(onPressed: _requestCode, child: const Text('Get a new code')),
        TextButton(onPressed: () => ref.read(sessionProvider.notifier).changeServer(), child: const Text('Use a different server')),
      ],
    );
  }
}
