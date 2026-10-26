import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:media_kit/media_kit.dart';
import 'package:media_kit_video/media_kit_video.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../../core/downloads/offline_manifest.dart';
import '../../core/downloads/offline_watch_queue.dart';
import '../../core/session/session_controller.dart';
import '../player/player_chrome.dart';
import '../player/player_system.dart';

/// Plays a saved download straight off disk — no server, no session. Its
/// progress lands in OfflineWatchQueue and syncs to the server the next
/// time Home loads with the server reachable (offline.ts's model).
class OfflineWatchScreen extends ConsumerStatefulWidget {
  const OfflineWatchScreen({super.key, required this.entry});
  final OfflineEntry entry;

  @override
  ConsumerState<OfflineWatchScreen> createState() => _OfflineWatchScreenState();
}

class _OfflineWatchScreenState extends ConsumerState<OfflineWatchScreen> {
  late final Player _player = Player();
  late final VideoController _controller = VideoController(_player);
  late final String? _profileId = ref.read(sessionProvider).profileId;
  Timer? _save;

  @override
  void initState() {
    super.initState();
    enterPlayerMode();
    WakelockPlus.enable();
    _open();
    _save = Timer.periodic(const Duration(seconds: 15), (_) => _record());
  }

  Future<void> _open() async {
    await _player.open(Media(Uri.file(widget.entry.localPath).toString()), play: false);
    final profileId = _profileId;
    final resume = profileId != null ? await OfflineWatchQueue.instance.positionFor(profileId, widget.entry.mediaItemId) : null;
    if (resume != null && resume > 5000) {
      await _player.stream.duration.firstWhere((d) => d > Duration.zero).timeout(const Duration(seconds: 5), onTimeout: () => Duration.zero);
      await _player.seek(Duration(milliseconds: resume));
    }
    await _player.play();
  }

  void _record() {
    final profileId = _profileId;
    final pos = _player.state.position.inMilliseconds;
    if (profileId == null || pos <= 0) return;
    final dur = _player.state.duration.inMilliseconds;
    OfflineWatchQueue.instance.record(profileId: profileId, mediaItemId: widget.entry.mediaItemId, positionMs: pos, durationMs: dur > 0 ? dur : widget.entry.durationMs);
  }

  @override
  void dispose() {
    _save?.cancel();
    _record();
    WakelockPlus.disable();
    exitPlayerMode();
    _player.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        fit: StackFit.expand,
        children: [
          Video(controller: _controller, controls: NoVideoControls, fill: Colors.black),
          PlayerChrome(
            player: _player,
            title: widget.entry.title,
            subtitle: widget.entry.subtitle ?? 'Playing from this device',
            offsetMs: 0,
            durationMs: 0,
            onSeek: (ms) => _player.seek(Duration(milliseconds: ms)),
            onBack: () => Navigator.of(context).maybePop(),
          ),
        ],
      ),
    );
  }
}
