import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/session/session_controller.dart';
import '../../core/widgets/wii_button.dart';
import '../common/gate_card.dart';

/// Fresh-install wizard — SetupView.tsx's first step (create the admin
/// account). Library setup stays on the web admin panel.
class FirstRunSetupScreen extends ConsumerStatefulWidget {
  const FirstRunSetupScreen({super.key});

  @override
  ConsumerState<FirstRunSetupScreen> createState() => _FirstRunSetupScreenState();
}

class _FirstRunSetupScreenState extends ConsumerState<FirstRunSetupScreen> {
  final _username = TextEditingController();
  final _password = TextEditingController();
  bool _submitting = false;
  String? _error;

  @override
  void dispose() {
    _username.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_username.text.trim().isEmpty || _password.text.length < 8) {
      setState(() => _error = 'Pick a username and a password of at least 8 characters.');
      return;
    }
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      await ref.read(sessionProvider.notifier).completeSetup(username: _username.text.trim(), password: _password.text);
    } catch (_) {
      if (mounted) setState(() => _error = "Couldn't create the admin account.");
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return GateCard(
      title: 'Create the admin account',
      subtitle: "This server has no accounts yet — you're first.",
      children: [
        AutofillGroup(
          child: Column(children: [
            TextField(
              controller: _username,
              autofocus: true,
              textInputAction: TextInputAction.next,
              autofillHints: const [AutofillHints.newUsername],
              decoration: const InputDecoration(labelText: 'Username'),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _password,
              obscureText: true,
              textInputAction: TextInputAction.done,
              autofillHints: const [AutofillHints.newPassword],
              decoration: const InputDecoration(labelText: 'Password (8+ characters)'),
              onSubmitted: (_) => _submit(),
            ),
          ]),
        ),
        GateError(_error),
        const SizedBox(height: 22),
        Center(child: WiiButton(label: 'Create account', busy: _submitting, onPressed: _submit)),
      ],
    );
  }
}
