import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:media_kit/media_kit.dart';
import 'package:media_kit_video/media_kit_video.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../../core/api/hokago_api.dart';
import '../../core/api/models/media_files.dart';
import '../../core/api/models/playback.dart';
import '../../core/session/session_controller.dart';
import '../../core/theme/app_theme.dart';

const _heartbeatInterval = Duration(seconds: 10);

/// Native player — libmpv (via media_kit) instead of the web's vidstack +
/// hls.js + JASSUB stack. libmpv renders ASS/SSA subtitles natively (the
/// same rendering pedigree JASSUB wraps in WASM), does HLS and fMP4 remux
/// playback itself, and needs no in-webview player — see
/// PLANS/HOKAGO_NATIVE_MOBILE_APP_PLAN.md for why this made a fully native
/// player screen viable at all.
///
/// Mirrors apps/web/src/WatchPage.tsx's contract semantics (timeline offset,
/// resume, seek-restart) but NOT its full sophistication: no retry queue for
/// a busy transcoder, no watch-party sync, no quality menu, no trickplay
/// scrubber preview yet — deliberately deferred, see task #6 in this
/// session's plan for the follow-up list.
class PlayerScreen extends ConsumerStatefulWidget {
  const PlayerScreen({super.key, required this.mediaFileId, required this.mediaItemId});
  final String mediaFileId;
  final String mediaItemId;

  @override
  ConsumerState<PlayerScreen> createState() => _PlayerScreenState();
}

class _PlayerScreenState extends ConsumerState<PlayerScreen> {
  late final Player _player = Player();
  late final VideoController _controller = VideoController(_player);

  StartPlaybackResponse? _start;
  String? _error;
  int _timelineOffsetMs = 0;
  int _absoluteDurationMs = 0;
  Timer? _heartbeatTimer;
  List<SubtitleTrackInfo> _serverSubtitles = [];
  SubtitleTrackInfo? _selectedServerSubtitle;
  List<MediaFileAudioTrackInfo> _serverAudioTracks = [];
  int? _selectedAudioIndex;
  bool _controlsVisible = true;
  bool _restarting = false;

  HokagoApi get _api => ref.read(sessionProvider.notifier).api;

  @override
  void initState() {
    super.initState();
    WakelockPlus.enable();
    _startPlayback();
  }

  @override
  void dispose() {
    _heartbeatTimer?.cancel();
    final sessionId = _start?.sessionId;
    if (sessionId != null) {
      // Fire-and-forget — mirrors the web's keepalive stop() on unmount.
      _api.stopPlayback(sessionId).catchError((_) {});
    }
    WakelockPlus.disable();
    _player.dispose();
    super.dispose();
  }

  Future<void> _startPlayback() async {
    final profileId = ref.read(sessionProvider).profileId;
    if (profileId == null) {
      setState(() => _error = 'No profile selected');
      return;
    }
    try {
      final start = await _api.startPlayback(profileId: profileId, mediaItemId: widget.mediaItemId, mediaFileId: widget.mediaFileId);
      _start = start;
      _absoluteDurationMs = start.absoluteDurationMs;

      int offset = 0;
      int? localSeekTargetSec;
      if (start.method == 'TRANSCODE' || start.method == 'REMUX') {
        offset = start.actualStartMs ?? start.resumePositionMs;
        if (start.resumePositionMs - offset > 1000) localSeekTargetSec = ((start.resumePositionMs - offset) / 1000).round();
      } else if (start.resumePositionMs > 0) {
        localSeekTargetSec = (start.resumePositionMs / 1000).round();
      }
      _timelineOffsetMs = offset;

      await _openMedia(_srcFor(start), initialSeekSec: localSeekTargetSec);
      _loadTracks();
      _startHeartbeat();
      if (mounted) setState(() {});
    } catch (e) {
      if (mounted) setState(() => _error = 'Could not start playback: $e');
    }
  }

  String _srcFor(StartPlaybackResponse start, {int cacheBust = 0}) {
    if (start.method == 'DIRECT_PLAY' || start.method == 'DIRECT_STREAM') {
      return _api.resolve('/media-files/${widget.mediaFileId}/direct');
    }
    if (start.method == 'REMUX' && start.streamUrl != null) {
      final url = _api.resolve(start.streamUrl!);
      return cacheBust > 0 ? '$url?r=$cacheBust' : url;
    }
    final url = _api.resolve(start.playlistUrl!);
    return cacheBust > 0 ? '$url?r=$cacheBust' : url;
  }

  Future<void> _openMedia(String url, {int? initialSeekSec}) async {
    // The stream itself needs a fresh bearer token attached as a raw HTTP
    // header (libmpv fetches it directly, outside the Dio interceptor chain).
    String? access;
    try {
      access = await _api.warmToken();
    } catch (_) {
      access = ref.read(sessionProvider).accessToken;
    }
    await _player.open(Media(url, httpHeaders: access != null ? {'Authorization': 'Bearer $access'} : null));
    if (initialSeekSec != null && initialSeekSec > 0) {
      // libmpv needs the file open before a seek lands — wait for the first
      // duration event (mirrors vidstack's canplay-gated pending seek).
      await _player.stream.duration.firstWhere((d) => d > Duration.zero).timeout(const Duration(seconds: 10), onTimeout: () => Duration.zero);
      await _player.seek(Duration(seconds: initialSeekSec));
    }
    await _player.play();
  }

  Future<void> _loadTracks() async {
    try {
      final tracks = await _api.mediaFileTracks(widget.mediaFileId);
      if (!mounted) return;
      setState(() {
        _serverSubtitles = tracks.subtitles.where((t) => !t.requiresBurnIn).toList();
        _serverAudioTracks = tracks.audio;
        _selectedAudioIndex = (tracks.audio.firstWhere((a) => a.isDefault, orElse: () => tracks.audio.isNotEmpty ? tracks.audio.first : MediaFileAudioTrackInfo(streamIndex: -1, codec: null, lang: null, title: null, isDefault: false))).streamIndex;
      });
    } catch (_) {
      // no tracks endpoint data — playback still works with the container's own default.
    }
  }

  void _startHeartbeat() {
    _heartbeatTimer?.cancel();
    _heartbeatTimer = Timer.periodic(_heartbeatInterval, (_) => _sendHeartbeat());
  }

  Future<void> _sendHeartbeat() async {
    final sessionId = _start?.sessionId;
    if (sessionId == null) return;
    final posMs = _player.state.position.inMilliseconds + _timelineOffsetMs;
    final durMs = _player.state.duration.inMilliseconds > 0 ? _player.state.duration.inMilliseconds + _timelineOffsetMs : null;
    try {
      await _api.heartbeat(sessionId, positionMs: posMs, durationMs: durMs);
    } catch (_) {
      // best-effort — a missed heartbeat just means a slightly stale resume point
    }
  }

  int get _absoluteMediaTimeMs => _player.state.position.inMilliseconds + _timelineOffsetMs;

  Future<void> _onScrub(int targetMediaMs) async {
    final start = _start;
    if (start == null) return;
    if (start.method == 'DIRECT_PLAY' || start.method == 'DIRECT_STREAM') {
      await _player.seek(Duration(milliseconds: targetMediaMs));
      return;
    }
    setState(() => _restarting = true);
    try {
      final outcome = await _api.seek(start.sessionId, targetMediaMs);
      if (!outcome.restarted) {
        await _player.seek(Duration(milliseconds: targetMediaMs - _timelineOffsetMs));
      } else {
        final newOffset = outcome.actualStartMs ?? targetMediaMs;
        _timelineOffsetMs = newOffset;
        final cacheBust = DateTime.now().millisecondsSinceEpoch;
        await _openMedia(_srcFor(start, cacheBust: cacheBust), initialSeekSec: ((targetMediaMs - newOffset) / 1000).round());
      }
    } catch (_) {
      // leave playback where it is — a failed restart shouldn't kill the session
    } finally {
      if (mounted) setState(() => _restarting = false);
    }
  }

  Future<void> _selectAudioTrack(int streamIndex) async {
    final start = _start;
    if (start == null) return;
    setState(() => _selectedAudioIndex = streamIndex);
    if (start.method == 'DIRECT_PLAY' || start.method == 'DIRECT_STREAM') {
      final native = _player.state.tracks.audio.where((t) => t.id == streamIndex.toString());
      if (native.isNotEmpty) await _player.setAudioTrack(native.first);
      return;
    }
    setState(() => _restarting = true);
    try {
      final posMs = _absoluteMediaTimeMs;
      final outcome = await _api.switchAudioTrack(start.sessionId, streamIndex, posMs);
      final newOffset = outcome.actualStartMs ?? posMs;
      _timelineOffsetMs = newOffset;
      final cacheBust = DateTime.now().millisecondsSinceEpoch;
      await _openMedia(_srcFor(start, cacheBust: cacheBust), initialSeekSec: ((posMs - newOffset) / 1000).round());
    } catch (_) {
      // keep the previous track playing
    } finally {
      if (mounted) setState(() => _restarting = false);
    }
  }

  Future<void> _selectSubtitle(SubtitleTrackInfo? track) async {
    setState(() => _selectedServerSubtitle = track);
    if (track == null) {
      await _player.setSubtitleTrack(SubtitleTrack.no());
      return;
    }
    final start = _start;
    if (start != null && (start.method == 'DIRECT_PLAY' || start.method == 'DIRECT_STREAM')) {
      // The raw container's own subtitle stream — libmpv lists it by id.
      final native = _player.state.tracks.subtitle.where((t) => (t.title ?? '') == (track.title ?? '') || t.language == track.lang);
      if (native.isNotEmpty) {
        await _player.setSubtitleTrack(native.first);
        return;
      }
    }
    // REMUX/TRANSCODE containers don't carry text subtitle streams — pull the
    // server's extracted sidecar text and feed it in-memory (SubtitleTrack.uri
    // has no per-request header support, and every hokago route needs auth).
    try {
      final text = await _api.subtitleText(widget.mediaFileId, track.id);
      await _player.setSubtitleTrack(SubtitleTrack.data(text, title: track.title ?? track.lang, language: track.lang));
    } catch (_) {
      // leave subtitles as they were — a failed fetch shouldn't kill playback
    }
  }

  void _showTrackSheet() {
    showModalBottomSheet(
      context: context,
      backgroundColor: HokagoColors.paper,
      builder: (_) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Padding(padding: EdgeInsets.all(16), child: Text('Audio & Subtitles', style: HokagoText.section)),
            if (_serverAudioTracks.length > 1) ...[
              const _SheetLabel('Audio'),
              for (final t in _serverAudioTracks)
                RadioListTile<int>(
                  value: t.streamIndex,
                  groupValue: _selectedAudioIndex,
                  title: Text(t.title ?? t.lang ?? 'Track ${t.streamIndex}', style: const TextStyle(color: HokagoColors.ink)),
                  onChanged: (v) {
                    Navigator.pop(context);
                    if (v != null) _selectAudioTrack(v);
                  },
                ),
            ],
            const _SheetLabel('Subtitles'),
            RadioListTile<String?>(
              value: null,
              groupValue: _selectedServerSubtitle?.id,
              title: const Text('Off', style: TextStyle(color: HokagoColors.ink)),
              onChanged: (_) {
                Navigator.pop(context);
                _selectSubtitle(null);
              },
            ),
            for (final t in _serverSubtitles)
              RadioListTile<String?>(
                value: t.id,
                groupValue: _selectedServerSubtitle?.id,
                title: Text(t.title ?? t.lang ?? t.format, style: const TextStyle(color: HokagoColors.ink)),
                onChanged: (_) {
                  Navigator.pop(context);
                  _selectSubtitle(t);
                },
              ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null) {
      return Scaffold(
        backgroundColor: Colors.black,
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Text(_error!, style: const TextStyle(color: Colors.white70), textAlign: TextAlign.center),
              const SizedBox(height: 16),
              OutlinedButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Back')),
            ]),
          ),
        ),
      );
    }
    if (_start == null) {
      return const Scaffold(backgroundColor: Colors.black, body: Center(child: CircularProgressIndicator()));
    }
    return Scaffold(
      backgroundColor: Colors.black,
      body: GestureDetector(
        onTap: () => setState(() => _controlsVisible = !_controlsVisible),
        child: Stack(
          fit: StackFit.expand,
          children: [
            Center(child: Video(controller: _controller, controls: NoVideoControls)),
            if (_restarting) const Center(child: CircularProgressIndicator()),
            AnimatedOpacity(
              opacity: _controlsVisible ? 1 : 0,
              duration: const Duration(milliseconds: 180),
              child: IgnorePointer(ignoring: !_controlsVisible, child: _Controls(
                player: _player,
                timelineOffsetMs: _timelineOffsetMs,
                absoluteDurationMs: _absoluteDurationMs,
                onScrub: _onScrub,
                onBack: () => Navigator.of(context).maybePop(),
                onTracks: _showTrackSheet,
              )),
            ),
          ],
        ),
      ),
    );
  }
}

class _SheetLabel extends StatelessWidget {
  const _SheetLabel(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
        child: Align(alignment: Alignment.centerLeft, child: Text(text.toUpperCase(), style: HokagoText.kicker.copyWith(color: HokagoColors.ink3))),
      );
}

class _Controls extends StatelessWidget {
  const _Controls({
    required this.player,
    required this.timelineOffsetMs,
    required this.absoluteDurationMs,
    required this.onScrub,
    required this.onBack,
    required this.onTracks,
  });

  final Player player;
  final int timelineOffsetMs;
  final int absoluteDurationMs;
  final void Function(int targetMediaMs) onScrub;
  final VoidCallback onBack;
  final VoidCallback onTracks;

  String _fmt(Duration d) {
    final s = d.inSeconds;
    final h = s ~/ 3600, m = (s % 3600) ~/ 60, sec = s % 60;
    final mm = h > 0 ? m.toString().padLeft(2, '0') : '$m';
    return h > 0 ? '$h:$mm:${sec.toString().padLeft(2, '0')}' : '$mm:${sec.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: [Colors.black54, Colors.transparent, Colors.transparent, Colors.black87],
          stops: const [0, 0.25, 0.6, 1],
        ),
      ),
      child: Column(
        children: [
          SafeArea(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8),
              child: Row(children: [
                IconButton(onPressed: onBack, icon: const Icon(Icons.arrow_back_rounded, color: Colors.white)),
                const Spacer(),
                IconButton(onPressed: onTracks, icon: const Icon(Icons.subtitles_outlined, color: Colors.white)),
              ]),
            ),
          ),
          const Spacer(),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              IconButton(
                iconSize: 36,
                color: Colors.white,
                onPressed: () => player.seek(player.state.position - const Duration(seconds: 10)),
                icon: const Icon(Icons.replay_10_rounded),
              ),
              const SizedBox(width: 24),
              StreamBuilder<bool>(
                stream: player.stream.playing,
                initialData: player.state.playing,
                builder: (_, snap) => IconButton(
                  iconSize: 56,
                  color: Colors.white,
                  onPressed: () => player.playOrPause(),
                  icon: Icon(snap.data == true ? Icons.pause_rounded : Icons.play_arrow_rounded),
                ),
              ),
              const SizedBox(width: 24),
              IconButton(
                iconSize: 36,
                color: Colors.white,
                onPressed: () => player.seek(player.state.position + const Duration(seconds: 10)),
                icon: const Icon(Icons.forward_10_rounded),
              ),
            ],
          ),
          const Spacer(),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 20),
            child: StreamBuilder<Duration>(
              stream: player.stream.position,
              initialData: player.state.position,
              builder: (_, posSnap) {
                final pos = posSnap.data ?? Duration.zero;
                final durMs = absoluteDurationMs > 0 ? absoluteDurationMs : player.state.duration.inMilliseconds + timelineOffsetMs;
                final curMs = pos.inMilliseconds + timelineOffsetMs;
                final ratio = durMs > 0 ? (curMs / durMs).clamp(0.0, 1.0) : 0.0;
                return Column(
                  children: [
                    SliderTheme(
                      data: SliderThemeData(
                        trackHeight: 3,
                        thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 6),
                        activeTrackColor: HokagoColors.accent,
                        inactiveTrackColor: Colors.white24,
                        thumbColor: HokagoColors.accent,
                      ),
                      child: Slider(
                        value: ratio,
                        onChanged: (v) {},
                        onChangeEnd: (v) => onScrub((v * durMs).round()),
                      ),
                    ),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        Text(_fmt(Duration(milliseconds: curMs)), style: const TextStyle(color: Colors.white70, fontSize: 12)),
                        Text(_fmt(Duration(milliseconds: durMs)), style: const TextStyle(color: Colors.white70, fontSize: 12)),
                      ],
                    ),
                  ],
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}
