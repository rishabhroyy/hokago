import 'dart:async';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:media_kit/media_kit.dart';
import 'package:media_kit_video/media_kit_video.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../../core/api/hokago_api.dart';
import '../../core/api/models/media_files.dart';
import '../../core/api/models/playback.dart';
import '../../core/party/party_controller.dart';
import '../../core/session/session_controller.dart';
import '../../core/theme/app_theme.dart';

const _heartbeatInterval = Duration(seconds: 10);

/// Same ladder as apps/web/src/WatchPage.tsx's QUALITY_OPTIONS — encode caps
/// sent to /playback/{id}/quality. "Original" carries no caps (reset: the
/// decider re-picks from the device profile's own ceiling).
class QualityOption {
  const QualityOption(this.label, {this.maxWidth, this.maxHeight, this.maxVideoBitrateKbps});
  final String label;
  final int? maxWidth, maxHeight, maxVideoBitrateKbps;
}

const _qualityOptions = [
  QualityOption('Original'),
  QualityOption('1080p', maxWidth: 1920, maxHeight: 1080, maxVideoBitrateKbps: 8000),
  QualityOption('720p', maxWidth: 1280, maxHeight: 720, maxVideoBitrateKbps: 3500),
  QualityOption('480p', maxWidth: 854, maxHeight: 480, maxVideoBitrateKbps: 1500),
];

/// Native player — libmpv (via media_kit) instead of the web's vidstack +
/// hls.js + JASSUB stack. libmpv renders ASS/SSA subtitles natively (the
/// same rendering pedigree JASSUB wraps in WASM), does HLS and fMP4 remux
/// playback itself, and needs no in-webview player — see
/// PLANS/HOKAGO_NATIVE_MOBILE_APP_PLAN.md for why this made a fully native
/// player screen viable at all.
///
/// Mirrors apps/web/src/WatchPage.tsx's contract semantics (timeline offset,
/// resume, seek-restart, quality switch, trickplay scrubber, watch-party
/// sync) but NOT its full sophistication: no retry queue for a busy
/// transcoder, and party sync always restarts the stream on drift instead of
/// distinguishing a "covered frontier" fast path that can land with a local
/// seek alone.
class PlayerScreen extends ConsumerStatefulWidget {
  const PlayerScreen({super.key, required this.mediaFileId, required this.mediaItemId, this.partyId});
  final String mediaFileId;
  final String mediaItemId;
  final String? partyId;

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
  MediaFileTrickplayResponse? _trickplay;
  String _selectedQuality = _qualityOptions.first.label;
  PartyController? _party;
  StreamSubscription<PartyCommand>? _partySub;
  StreamSubscription<dynamic>? _partyStateSub;
  bool _partyApplying = false;

  HokagoApi get _api => ref.read(sessionProvider.notifier).api;

  @override
  void initState() {
    super.initState();
    WakelockPlus.enable();
    _startPlayback();
    final partyId = widget.partyId;
    final profileId = ref.read(sessionProvider).profileId;
    if (partyId != null && profileId != null) {
      final party = PartyController(_api, partyId: partyId, profileId: profileId);
      _party = party;
      _partySub = party.commands.listen(_applyPartyCommand);
      _partyStateSub = party.partyUpdates.listen((_) => setState(() {})); // member list / host / locked changes
    }
  }

  @override
  void dispose() {
    _heartbeatTimer?.cancel();
    _partySub?.cancel();
    _partyStateSub?.cancel();
    final party = _party;
    if (party != null && !party.isHost) party.leave();
    party?.dispose();
    final sessionId = _start?.sessionId;
    if (sessionId != null) {
      // Fire-and-forget — mirrors the web's keepalive stop() on unmount.
      _api.stopPlayback(sessionId).catchError((_) {});
    }
    WakelockPlus.disable();
    _player.dispose();
    super.dispose();
  }

  /// Applies a server-issued party command (mine, echoed back, are filtered
  /// out by PartyController before reaching here). WAITING/PAUSED are a flat
  /// anchor; PLAYING advances with wall-clock since issuedAt — same math as
  /// WatchPage.tsx's applyPartyCommand, simplified: always restarts the
  /// stream on real drift rather than distinguishing a fast local-seek path.
  Future<void> _applyPartyCommand(PartyCommand cmd) async {
    if (_start == null || _partyApplying) return;
    _partyApplying = true;
    try {
      final issuedAt = DateTime.tryParse(cmd.issuedAt) ?? DateTime.now();
      final targetMs = cmd.state == 'PLAYING' ? cmd.positionMs + DateTime.now().difference(issuedAt).inMilliseconds.clamp(0, 1 << 30) : cmd.positionMs;
      final myMs = _absoluteMediaTimeMs;
      final drifted = (targetMs - myMs).abs() > 3000;
      if (drifted) await _onScrub(targetMs, fromParty: true);
      if (cmd.state == 'PLAYING') {
        await _player.play();
      } else {
        await _player.pause();
      }
    } finally {
      _partyApplying = false;
    }
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
      if (_party != null) unawaited(_party!.linkSession(start.sessionId));
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
    // Scrubber-preview index — absent until sheets are generated; the
    // scrubber just shows the clock until this arrives, same as the web.
    final trickplay = await _api.mediaFileTrickplay(widget.mediaFileId);
    if (mounted && trickplay != null) setState(() => _trickplay = trickplay);
  }

  Future<void> _selectQuality(QualityOption option) async {
    final start = _start;
    if (start == null) return;
    setState(() => _selectedQuality = option.label);
    setState(() => _restarting = true);
    try {
      final posMs = _absoluteMediaTimeMs;
      final outcome = await _api.switchQuality(
        start.sessionId,
        positionMs: posMs,
        reset: option.maxWidth == null,
        maxWidth: option.maxWidth,
        maxHeight: option.maxHeight,
        maxVideoBitrateKbps: option.maxVideoBitrateKbps,
      );
      // A quality switch can change the method entirely (e.g. REMUX at 1080p
      // -> TRANSCODE at 480p, or a capped TRANSCODE -> DIRECT_PLAY on reset)
      // — rebuild `_start` with the new method/URLs so _srcFor picks the
      // right source next time, not just the old method's.
      _start = StartPlaybackResponse(
        sessionId: start.sessionId,
        method: outcome.method,
        playlistUrl: outcome.playlistUrl,
        streamUrl: outcome.streamUrl,
        resumePositionMs: start.resumePositionMs,
        absoluteDurationMs: start.absoluteDurationMs,
        actualStartMs: outcome.actualStartMs,
      );
      final newOffset = outcome.actualStartMs ?? posMs;
      _timelineOffsetMs = newOffset;
      final cacheBust = DateTime.now().millisecondsSinceEpoch;
      await _openMedia(_srcFor(_start!, cacheBust: cacheBust), initialSeekSec: ((posMs - newOffset) / 1000).round());
    } catch (_) {
      // keep playing at the previous quality
    } finally {
      if (mounted) setState(() => _restarting = false);
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

  Future<void> _onScrub(int targetMediaMs, {bool fromParty = false}) async {
    final start = _start;
    if (start == null) return;
    // Guests in a live party don't own the timeline — only a party-command-
    // driven call (fromParty) may move it; a stray manual gesture is a no-op
    // (the UI also disables the slider, this is the belt-and-suspenders check).
    if (!fromParty && (_party?.locked ?? false)) return;
    if (start.method == 'DIRECT_PLAY' || start.method == 'DIRECT_STREAM') {
      await _player.seek(Duration(milliseconds: targetMediaMs));
    } else {
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
    // The host scrubbing is also a timekeeper command — moves the whole room.
    final party = _party;
    if (!fromParty && party != null && party.isHost) {
      unawaited(party.control(_player.state.playing ? 'PLAYING' : 'PAUSED', targetMediaMs));
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
            Padding(padding: const EdgeInsets.all(16), child: Text('Audio & Subtitles', style: HokagoText.section)),
            if (_serverAudioTracks.length > 1) ...[
              const _SheetLabel('Audio'),
              for (final t in _serverAudioTracks)
                RadioListTile<int>(
                  value: t.streamIndex,
                  groupValue: _selectedAudioIndex,
                  title: Text(t.title ?? t.lang ?? 'Track ${t.streamIndex}', style: TextStyle(color: HokagoColors.ink)),
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
              title: Text('Off', style: TextStyle(color: HokagoColors.ink)),
              onChanged: (_) {
                Navigator.pop(context);
                _selectSubtitle(null);
              },
            ),
            for (final t in _serverSubtitles)
              RadioListTile<String?>(
                value: t.id,
                groupValue: _selectedServerSubtitle?.id,
                title: Text(t.title ?? t.lang ?? t.format, style: TextStyle(color: HokagoColors.ink)),
                onChanged: (_) {
                  Navigator.pop(context);
                  _selectSubtitle(t);
                },
              ),
            const _SheetLabel('Quality'),
            for (final q in _qualityOptions)
              RadioListTile<String>(
                value: q.label,
                groupValue: _selectedQuality,
                title: Text(q.label, style: TextStyle(color: HokagoColors.ink)),
                onChanged: (_) {
                  Navigator.pop(context);
                  _selectQuality(q);
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
                trickplay: _trickplay,
                resolveUrl: _api.resolve,
                accessToken: ref.watch(sessionProvider).accessToken,
                onScrub: _onScrub,
                onBack: () => Navigator.of(context).maybePop(),
                onTracks: _showTrackSheet,
                partyMemberCount: _party?.party?.members.length,
                partyLocked: _party?.locked ?? false,
                onHostToggle: _party != null && _party!.isHost
                    ? () => unawaited(_party!.control(_player.state.playing ? 'PLAYING' : 'PAUSED', _absoluteMediaTimeMs))
                    : null,
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
    this.trickplay,
    this.resolveUrl,
    this.accessToken,
    this.partyMemberCount,
    this.partyLocked = false,
    this.onHostToggle,
  });

  final Player player;
  final int timelineOffsetMs;
  final int absoluteDurationMs;
  final void Function(int targetMediaMs) onScrub;
  final VoidCallback onBack;
  final VoidCallback onTracks;
  final MediaFileTrickplayResponse? trickplay;
  final String Function(String path)? resolveUrl;
  final String? accessToken;
  final int? partyMemberCount;
  /// Guest in a live party — the host owns play/pause/seek; gestures here
  /// are inert (mirrors WatchPage.tsx's `locked` prop on the stock slider).
  final bool partyLocked;
  /// Host only: called right after a local play/pause toggle so the parent
  /// can broadcast it as the room's new timekeeper state.
  final VoidCallback? onHostToggle;

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
                if (partyMemberCount != null)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                    margin: const EdgeInsets.only(right: 8),
                    decoration: BoxDecoration(color: Colors.white.withValues(alpha: 0.15), borderRadius: BorderRadius.circular(HokagoRadii.pill)),
                    child: Row(mainAxisSize: MainAxisSize.min, children: [
                      const Icon(Icons.groups_rounded, color: Colors.white, size: 15),
                      const SizedBox(width: 5),
                      Text('$partyMemberCount', style: const TextStyle(color: Colors.white, fontSize: 12.5, fontWeight: FontWeight.w700)),
                    ]),
                  ),
                IconButton(onPressed: onTracks, icon: const Icon(Icons.subtitles_outlined, color: Colors.white)),
              ]),
            ),
          ),
          const Spacer(),
          IgnorePointer(
            ignoring: partyLocked,
            child: Opacity(
              opacity: partyLocked ? 0.4 : 1,
              child: Row(
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
                  onPressed: () {
                    player.playOrPause();
                    onHostToggle?.call();
                  },
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
            ),
          ),
          const Spacer(),
          IgnorePointer(
          ignoring: partyLocked,
          child: Padding(
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
                    _Scrubber(
                      ratio: ratio,
                      durationMs: durMs,
                      trickplay: trickplay,
                      resolveUrl: resolveUrl,
                      accessToken: accessToken,
                      onScrubEnd: (v) => onScrub((v * durMs).round()),
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
          ),
        ],
      ),
    );
  }
}

/// Absolute-position scrubber with a trickplay preview thumbnail — mirrors
/// WatchPage.tsx's AbsoluteTimeSlider's hoverTile math: tile N lives at
/// sheets[N ~/ tilesPerSheet], cropped to (N % tilesPerSheet) % cols,
/// (N % tilesPerSheet) ~/ cols within that sheet's fixed grid. No VTT, pure
/// arithmetic from the trickplay index the server already returns.
class _Scrubber extends StatefulWidget {
  const _Scrubber({
    required this.ratio,
    required this.durationMs,
    required this.onScrubEnd,
    this.trickplay,
    this.resolveUrl,
    this.accessToken,
  });

  final double ratio;
  final int durationMs;
  final void Function(double ratio) onScrubEnd;
  final MediaFileTrickplayResponse? trickplay;
  final String Function(String path)? resolveUrl;
  final String? accessToken;

  @override
  State<_Scrubber> createState() => _ScrubberState();
}

class _ScrubberState extends State<_Scrubber> {
  double? _dragRatio;

  ({TrickplaySheet sheet, int col, int row, int rows})? _tileFor(double ratio) {
    final tp = widget.trickplay;
    if (tp == null || widget.durationMs <= 0) return null;
    final mediaMs = ratio * widget.durationMs;
    final totalTiles = tp.sheets.fold<int>(0, (sum, s) => sum + s.tiles);
    if (totalTiles == 0) return null;
    final tileIndex = (mediaMs / tp.intervalMs).floor().clamp(0, totalTiles - 1);
    final sheetIndex = (tileIndex / tp.tilesPerSheet).floor();
    if (sheetIndex >= tp.sheets.length) return null;
    final sheet = tp.sheets[sheetIndex];
    final inSheet = tileIndex % tp.tilesPerSheet;
    final col = inSheet % tp.cols;
    final rows = (tp.tilesPerSheet / tp.cols).ceil();
    final row = (inSheet / tp.cols).floor();
    return (sheet: sheet, col: col, row: row, rows: rows);
  }

  @override
  Widget build(BuildContext context) {
    final shown = _dragRatio ?? widget.ratio;
    final tp = widget.trickplay;
    final tile = _dragRatio != null ? _tileFor(shown) : null;

    return LayoutBuilder(
      builder: (context, constraints) {
        return SizedBox(
          height: tile != null && tp != null ? 100 : 28,
          child: Stack(
            clipBehavior: Clip.none,
            alignment: Alignment.bottomCenter,
            children: [
              if (tile != null && tp != null && widget.resolveUrl != null)
                Positioned(
                  left: (shown.clamp(0.0, 1.0) * constraints.maxWidth - tp.tileWidth / 4).clamp(0.0, constraints.maxWidth - tp.tileWidth / 2),
                  top: 0,
                  child: DecoratedBox(
                    decoration: BoxDecoration(borderRadius: BorderRadius.circular(6), boxShadow: const [BoxShadow(color: Colors.black54, blurRadius: 8)]),
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(6),
                      child: SizedBox(
                        width: tp.tileWidth / 2,
                        height: tp.tileHeight / 2,
                        child: OverflowBox(
                          maxWidth: tp.tileWidth / 2 * tp.cols,
                          maxHeight: tp.tileHeight / 2 * tile.rows,
                          alignment: Alignment.topLeft,
                          child: Transform.translate(
                            offset: Offset(-tile.col * tp.tileWidth / 2, -tile.row * tp.tileHeight / 2),
                            child: CachedNetworkImage(
                              imageUrl: widget.resolveUrl!(tile.sheet.url),
                              httpHeaders: widget.accessToken != null ? {'Authorization': 'Bearer ${widget.accessToken}'} : null,
                              width: tp.tileWidth / 2 * tp.cols,
                              height: tp.tileHeight / 2 * tile.rows,
                              fit: BoxFit.fill,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              Positioned(
                left: 0,
                right: 0,
                bottom: 0,
                child: SliderTheme(
                  data: SliderThemeData(
                    trackHeight: 3,
                    thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 6),
                    activeTrackColor: HokagoColors.accent,
                    inactiveTrackColor: Colors.white24,
                    thumbColor: HokagoColors.accent,
                  ),
                  child: Slider(
                    value: shown.clamp(0.0, 1.0),
                    onChangeStart: (v) => setState(() => _dragRatio = v),
                    onChanged: (v) => setState(() => _dragRatio = v),
                    onChangeEnd: (v) {
                      widget.onScrubEnd(v);
                      setState(() => _dragRatio = null);
                    },
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}
