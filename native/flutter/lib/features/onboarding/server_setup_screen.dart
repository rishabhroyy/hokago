import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/session/session_controller.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/wii_button.dart';
import '../common/gate_card.dart';

class ServerSetupScreen extends ConsumerStatefulWidget {
  const ServerSetupScreen({super.key});

  @override
  ConsumerState<ServerSetupScreen> createState() => _ServerSetupScreenState();
}

class _ServerSetupScreenState extends ConsumerState<ServerSetupScreen> {
  late final _controller = TextEditingController(text: ref.read(sessionProvider).serverUrl ?? '');
  bool _connecting = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _connect() async {
    if (_controller.text.trim().isEmpty) return;
    setState(() => _connecting = true);
    await ref.read(sessionProvider.notifier).setServerUrl(_controller.text);
    if (mounted) setState(() => _connecting = false);
  }

  @override
  Widget build(BuildContext context) {
    final error = ref.watch(sessionProvider.select((s) => s.error));
    return GateCard(
      title: 'hokago',
      subtitle: 'Enter your server address to get started.',
      children: [
        TextField(
          controller: _controller,
          keyboardType: TextInputType.url,
          autocorrect: false,
          autofocus: true,
          textInputAction: TextInputAction.go,
          autofillHints: const [AutofillHints.url],
          decoration: const InputDecoration(labelText: 'Server address', hintText: '192.168.1.20:3000 or hokago.example.com'),
          onSubmitted: (_) => _connect(),
        ),
        GateError(error),
        const SizedBox(height: 22),
        Center(child: WiiButton(label: 'Continue', busy: _connecting, onPressed: _connect)),
        const SizedBox(height: 14),
        const Text('Local addresses (IPs, .local names) connect over http; domains over https. Type http:// or https:// to choose.', textAlign: TextAlign.center, style: HokagoText.small),
      ],
    );
  }
}
