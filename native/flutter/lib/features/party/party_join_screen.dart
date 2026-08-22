import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/session/session_controller.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/hokago_panel.dart';
import '../../core/widgets/wii_button.dart';

/// Join a watch party by invite code — mirrors apps/web's /party route
/// (PartyView.tsx). Hosting a party starts from the detail screen's Watch
/// party button instead (needs a media item to attach to).
class PartyJoinScreen extends ConsumerStatefulWidget {
  const PartyJoinScreen({super.key});
  @override
  ConsumerState<PartyJoinScreen> createState() => _PartyJoinScreenState();
}

class _PartyJoinScreenState extends ConsumerState<PartyJoinScreen> {
  final _code = TextEditingController();
  bool _joining = false;
  String? _error;

  Future<void> _join() async {
    final profileId = ref.read(sessionProvider).profileId;
    if (profileId == null || _code.text.trim().isEmpty) return;
    setState(() {
      _joining = true;
      _error = null;
    });
    try {
      final api = ref.read(sessionProvider.notifier).api;
      final party = await api.joinParty(inviteCode: _code.text.trim(), profileId: profileId);
      if (party.mediaFileId == null) throw Exception('This party has nothing playable yet');
      if (mounted) context.go('/watch/${party.mediaFileId}?mediaItemId=${party.mediaItemId}&party=${party.id}');
    } catch (e) {
      setState(() => _error = "Couldn't join — check the code and try again.");
    } finally {
      if (mounted) setState(() => _joining = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Join watch party')),
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
                  Icon(Icons.groups_rounded, size: 40, color: HokagoColors.wiiDeep),
                  const SizedBox(height: 12),
                  Text('Enter the invite code', style: HokagoText.section, textAlign: TextAlign.center),
                  const SizedBox(height: 20),
                  TextField(
                    controller: _code,
                    textCapitalization: TextCapitalization.characters,
                    textAlign: TextAlign.center,
                    style: HokagoText.title.copyWith(letterSpacing: 4),
                    decoration: const InputDecoration(hintText: 'CODE'),
                    onSubmitted: (_) => _join(),
                  ),
                  if (_error != null) ...[
                    const SizedBox(height: 12),
                    Text(_error!, style: const TextStyle(color: Colors.redAccent, fontSize: 13)),
                  ],
                  const SizedBox(height: 20),
                  Center(
                    child: WiiButton(
                      onPressed: _joining ? null : _join,
                      child: _joining
                          ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                          : const Text('Join'),
                    ),
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
