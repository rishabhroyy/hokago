import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/session/session_controller.dart';
import '../../core/theme/app_theme.dart';
import '../common/gate_card.dart';
import '../../core/widgets/wii_button.dart';

/// Join a watch party by invite code — apps/web's /party (PartyView.tsx).
/// Hosting starts from a title's Watch party button. Reached from Home's
/// top bar (it was unreachable before).
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
      if (party.mediaFileId == null) throw StateError('nothing playable');
      if (mounted) context.pushReplacement('/watch/${party.mediaFileId}?mediaItemId=${party.mediaItemId}&party=${party.id}');
    } catch (e) {
      setState(() => _error = "Couldn't join — check the code and try again.");
    } finally {
      if (mounted) setState(() => _joining = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Stack(children: [
      GateCard(
        title: 'Join a watch party',
        subtitle: 'Enter the invite code a friend shared.',
        children: [
          TextField(
            controller: _code,
            autofocus: true,
            textCapitalization: TextCapitalization.characters,
            autocorrect: false,
            textAlign: TextAlign.center,
            style: HokagoText.title.copyWith(letterSpacing: 6),
            decoration: const InputDecoration(hintText: 'CODE'),
            onSubmitted: (_) => _join(),
          ),
          GateError(_error),
          const SizedBox(height: 22),
          Center(child: WiiButton(icon: 'users', label: 'Join', busy: _joining, onPressed: _join)),
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
