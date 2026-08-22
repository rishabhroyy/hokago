import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/session/session_controller.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/hokago_panel.dart';
import '../../core/widgets/wii_button.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _username = TextEditingController();
  final _password = TextEditingController();
  bool _submitting = false;

  Future<void> _submit() async {
    setState(() => _submitting = true);
    await ref.read(sessionProvider.notifier).login(username: _username.text.trim(), password: _password.text);
    if (mounted) setState(() => _submitting = false);
  }

  @override
  Widget build(BuildContext context) {
    final session = ref.watch(sessionProvider);
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: HokagoPanel(
              padding: const EdgeInsets.all(28),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Icon(Icons.local_movies_rounded, size: 48, color: HokagoColors.accent),
                  const SizedBox(height: 16),
                  Text('Welcome back', style: HokagoText.section),
                  const SizedBox(height: 20),
                  TextField(controller: _username, decoration: const InputDecoration(labelText: 'Username'), onSubmitted: (_) => _submit()),
                  const SizedBox(height: 12),
                  TextField(
                    controller: _password,
                    obscureText: true,
                    decoration: const InputDecoration(labelText: 'Password'),
                    onSubmitted: (_) => _submit(),
                  ),
                  if (session.error != null) ...[
                    const SizedBox(height: 12),
                    Text(session.error!, style: const TextStyle(color: Colors.redAccent, fontSize: 13)),
                  ],
                  const SizedBox(height: 20),
                  Center(
                    child: WiiButton(
                      onPressed: _submitting ? null : _submit,
                      child: _submitting
                          ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                          : const Text('Log in'),
                    ),
                  ),
                  const SizedBox(height: 8),
                  TextButton(
                    onPressed: () => ref.read(sessionProvider.notifier).changeServer(),
                    child: Text('Not ${session.serverUrl ?? 'this server'}?', style: const TextStyle(color: HokagoColors.ink2)),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
