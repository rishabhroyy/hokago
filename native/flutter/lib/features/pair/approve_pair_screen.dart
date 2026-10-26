import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/session/session_controller.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/wii_button.dart';
import '../common/gate_card.dart';

/// The phone side of TV pairing (web: TvPairFlow's approve step) — type the
/// code a TV is showing and it signs in as this account. Was web-only.
class ApprovePairScreen extends ConsumerStatefulWidget {
  const ApprovePairScreen({super.key});
  @override
  ConsumerState<ApprovePairScreen> createState() => _ApprovePairScreenState();
}

class _ApprovePairScreenState extends ConsumerState<ApprovePairScreen> {
  final _code = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  Future<void> _approve() async {
    final code = _code.text.replaceAll(RegExp(r'\s'), '');
    if (code.length < 4) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(sessionProvider.notifier).api.pairVerify(code);
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Approved — the TV is signing in')));
      context.pop();
    } catch (_) {
      if (mounted) setState(() => _error = "That code didn't match — codes expire after a few minutes.");
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Stack(children: [
      GateCard(
        title: 'Approve a device',
        subtitle: 'Enter the code shown on your TV or other device.',
        children: [
          TextField(
            controller: _code,
            autofocus: true,
            keyboardType: TextInputType.number,
            textAlign: TextAlign.center,
            maxLength: 8,
            inputFormatters: [FilteringTextInputFormatter.digitsOnly],
            style: HokagoText.title.copyWith(letterSpacing: 8, fontFeatures: const [FontFeature.tabularFigures()]),
            decoration: const InputDecoration(hintText: '000000', counterText: ''),
            onSubmitted: (_) => _approve(),
          ),
          GateError(_error),
          const SizedBox(height: 22),
          Center(child: WiiButton(icon: 'check', label: 'Approve', busy: _busy, onPressed: _approve)),
        ],
      ),
      Positioned(
        top: MediaQuery.paddingOf(context).top + 10,
        left: 16,
        child: GlassIconButton(icon: 'back', semanticLabel: 'Back', onPressed: () => context.pop()),
      ),
    ]);
  }
}
