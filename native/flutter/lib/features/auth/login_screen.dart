import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/session/session_controller.dart';
import '../../core/widgets/wii_button.dart';
import '../common/gate_card.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _username = TextEditingController();
  final _password = TextEditingController();
  bool _submitting = false;

  @override
  void dispose() {
    _username.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_username.text.trim().isEmpty || _password.text.isEmpty) return;
    setState(() => _submitting = true);
    TextInput.finishAutofillContext();
    await ref.read(sessionProvider.notifier).login(username: _username.text.trim(), password: _password.text);
    if (mounted) setState(() => _submitting = false);
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(sessionProvider);
    final host = Uri.tryParse(session.serverUrl ?? '')?.host;
    return GateCard(
      title: 'Welcome back',
      subtitle: host != null && host.isNotEmpty ? 'Sign in to $host' : null,
      children: [
        AutofillGroup(
          child: Column(children: [
            TextField(
              controller: _username,
              autofocus: true,
              autocorrect: false,
              textInputAction: TextInputAction.next,
              autofillHints: const [AutofillHints.username],
              decoration: const InputDecoration(labelText: 'Username'),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _password,
              obscureText: true,
              textInputAction: TextInputAction.done,
              autofillHints: const [AutofillHints.password],
              decoration: const InputDecoration(labelText: 'Password'),
              onSubmitted: (_) => _submit(),
            ),
          ]),
        ),
        GateError(session.error),
        const SizedBox(height: 22),
        Center(child: WiiButton(label: 'Sign in', busy: _submitting, onPressed: _submit)),
        const SizedBox(height: 14),
        TextButton(onPressed: () => context.push('/pair'), child: const Text('Sign in with a code from another device')),
        TextButton(onPressed: () => ref.read(sessionProvider.notifier).changeServer(), child: const Text('Use a different server')),
      ],
    );
  }
}
