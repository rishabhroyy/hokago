import 'dart:async';

import 'package:cached_network_image/cached_network_image.dart';
import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:media_kit/media_kit.dart';
import 'package:media_kit_video/media_kit_video.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../../core/api/hokago_api.dart';
import '../../core/api/models/browse.dart';
import '../../core/api/models/media_files.dart';
import '../../core/api/models/playback.dart';
import '../../core/language_names.dart';
import '../../core/party/party_controller.dart';
import '../../core/session/session_controller.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/hokago_icon.dart';
import '../../core/widgets/pressable.dart';
import '../../core/widgets/wii_button.dart';
import '../detail/detail_screen.dart' show nextEpisodeAfter;
import 'player_chrome.dart';
import 'player_system.dart';
import 'track_prefs.dart';

const _heartbeatInterval = Duration(seconds: 10);
const _upNextSeconds = 8;

/// Same ladder as WatchPage.tsx's QUALITY_OPTIONS — encode caps for
/// /playback/{id}/quality. "Original" carries none (the decider re-picks).
class QualityOption {
  const QualityOption(this.label, {this.maxWidth, this.maxHeight, this.maxVideoBitrateKbps});
  final String label;
  final int? maxWidth, maxHeight, maxVideoBitrateKbps;
}

const qualityOptions = [
  QualityOption('Original'),
  QualityOption('1080p', maxWidth: 1920, maxHeight: 1080, maxVideoBitrateKbps: 8000),
  QualityOption('720p', maxWidth: 1280, maxHeight: 720, maxVideoBitrateKbps: 3500),
  QualityOption('480p', maxWidth: 854, maxHeight: 480, maxVideoBitrateKbps: 1500),
];

bool _isDirect(String method) => method == 'DIRECT_PLAY' || method == 'DIRECT_STREAM';

/// Native player — libmpv (media_kit) instead of the web's vidstack + hls.js
/// + JASSUB; libmpv renders ASS natively and plays HLS / fMP4 itself.
///
/// Mirrors WatchPage.tsx's contract semantics: timeline offset, resume,
/// server-side seek restarts, audio/quality switches, trickplay, watch-party
/// sync, a busy-transcoder (503) retry, remembered track choices. Party sync
/// always restarts the stream on real drift rather than the web's "covered
/// frontier" local-seek fast path.
class PlayerScreen extends ConsumerStatefulWidget {
  const PlayerScreen({super.key, required this.mediaFileId, required this.mediaItemId, this.partyId, this.audioStreamIndex, this.seriesId});
  final String mediaFileId;
  final String mediaItemId;
  final String? partyId;
  final int? audioStreamIndex;

  /// The parent series, when known — enables the up-next card at the end.
  final String? seriesId;

  @override
  ConsumerState<PlayerScreen> createState() => _PlayerScreenState();
}

class _PlayerScreenState extends ConsumerState<PlayerScreen> {
  late final Player _player = Player();
  late final VideoController _controller = VideoController(_player);
  late final HokagoApi _api = ref.read(sessionProvider.notifier).api;

  StartPlaybackResponse? _start;
  bool _failed = false;
  int _timelineOffsetMs = 0;
  int _absoluteDurationMs = 0;
  Timer? _heartbeatTimer;
  TrackPrefs _prefs = const TrackPrefs();
  List<SubtitleTrackInfo> _subtitles = [];
  SubtitleTrackInfo? _subtitle;
  List<MediaFileAudioTrackInfo> _audioTracks = [];
  int? _audioIndex;
  String _quality = qualityOptions.first.label;
  bool _restarting = false;
  MediaFileTrickplayResponse? _trickplay;
  String _title = '';
  String? _subtitleLine;
  EpisodeCard? _next;
  int? _upNextCountdown;
  Timer? _upNextTimer;
  StreamSubscription<bool>? _completedSub;

  PartyController? _party;
  StreamSubscription<PartyCommand>? _partySub;
  StreamSubscription<dynamic>? _partyStateSub;
  bool _partyApplying = false;

  @override
  void initState() {
    super.initState();
    enterPlayerMode();
    WakelockPlus.enable();
    _startPlayback();
    _loadTitle();
    _completedSub = _player.stream.completed.listen((done) {
      if (done) _onCompleted();
    });
    final partyId = widget.partyId;
    final profileId = ref.read(sessionProvider).profileId;
    if (partyId != null && profileId != null) {
      final party = PartyController(_api, partyId: partyId, profileId: profileId);
      _party = party;
      _partySub = party.commands.listen(_applyPartyCommand);
      _partyStateSub = party.partyUpdates.listen((_) => setState(() {}));
    }
  }

  @override
  void dispose() {
    _heartbeatTimer?.cancel();
    _upNextTimer?.cancel();
    _completedSub?.cancel();
    _partySub?.cancel();
    _partyStateSub?.cancel();
    final party = _party;
    if (party != null && !party.isHost) party.leave();
    party?.dispose();
    final sessionId = _start?.sessionId;
    if (sessionId != null) {
      // Last position first, then stop — fire-and-forget, like the web's keepalive stop().
      final pos = _absoluteMediaTimeMs;
      _api
          .heartbeat(sessionId, positionMs: pos, durationMs: _absoluteDurationMs > 0 ? _absoluteDurationMs : null)
          .catchError((_) {})
          .whenComplete(() => _api.stopPlayback(sessionId).catchError((_) {}));
    }
    WakelockPlus.disable();
    exitPlayerMode();
    _player.dispose();
    super.dispose();
  }

  int get _absoluteMediaTimeMs => _player.state.position.inMilliseconds + _timelineOffsetMs;

  // ── boot ───────────────────────────────────────────────────────────────

  Future<void> _loadTitle() async {
    final profileId = ref.read(sessionProvider).profileId;
    try {
      final item = await _api.mediaItemDetail(widget.mediaItemId, profileId: profileId);
      if (mounted) setState(() => _title = item.title);
      final seriesId = widget.seriesId;
      if (seriesId == null || seriesId == widget.mediaItemId) return;
      final series = await _api.mediaItemDetail(seriesId, profileId: profileId);
      final all = [...series.episodes, ...series.movies];
      final current = all.where((e) => e.id == widget.mediaItemId).firstOrNull;
      if (!mounted) return;
      setState(() {
        _title = series.title;
        if (current != null) {
          _subtitleLine = current.episodeNumber != null ? 'S${current.seasonNumber ?? 1} E${current.episodeNumber} · ${current.title}' : current.title;
        }
        _next = nextEpisodeAfter(series, widget.mediaItemId);
      });
    } catch (_) {
      // a title is decoration — playback doesn't depend on it
    }
  }

  Future<void> _startPlayback() async {
    final profileId = ref.read(sessionProvider).profileId;
    if (profileId == null) {
      setState(() => _failed = true);
      return;
    }
    setState(() => _failed = false);
    _prefs = await TrackPrefs.load();
    MediaFileTracksResponse? tracks;
    try {
      tracks = await _api.mediaFileTracks(widget.mediaFileId);
    } catch (_) {
      // playback still works with the container's defaults
    }
    final audio = widget.audioStreamIndex ?? (tracks != null ? pickAudio(tracks.audio, _prefs)?.streamIndex : null);
    final quality = qualityOptions.firstWhere((q) => q.label == _prefs.quality, orElse: () => qualityOptions.first);
    try {
      StartPlaybackResponse? start;
      // The transcoder is capped per server (HOKAGO_MAX_TRANSCODES): a busy
      // cap answers 503 — back off and retry, like WatchPage.tsx.
      for (var attempt = 0; ; attempt++) {
        try {
          start = await _api.startPlayback(
            profileId: profileId,
            mediaItemId: widget.mediaItemId,
            mediaFileId: widget.mediaFileId,
            audioStreamIndex: audio,
            deviceProfile: DeviceProfile.native.withCaps(maxWidth: quality.maxWidth, maxHeight: quality.maxHeight, maxVideoBitrateKbps: quality.maxVideoBitrateKbps),
          );
          break;
        } on DioException catch (e) {
          if (e.response?.statusCode != 503 || attempt >= 4) rethrow;
          await Future.delayed(Duration(milliseconds: 1200 * (attempt + 1)));
          if (!mounted) return;
        }
      }
      if (!mounted) return;
      _start = start;
      _absoluteDurationMs = start.absoluteDurationMs;
      _quality = quality.label;

      int? localSeekSec;
      var offset = 0;
      if (!_isDirect(start.method)) {
        offset = start.actualStartMs ?? start.resumePositionMs;
        if (start.resumePositionMs - offset > 1000) localSeekSec = ((start.resumePositionMs - offset) / 1000).round();
      } else if (start.resumePositionMs > 0) {
        localSeekSec = (start.resumePositionMs / 1000).round();
      }
      _timelineOffsetMs = offset;
      await _openMedia(_srcFor(start), initialSeekSec: localSeekSec);
      if (tracks != null) _applyTracks(tracks, audio);
      _startHeartbeat();
      if (_party != null) unawaited(_party!.linkSession(start.sessionId));
      if (mounted) setState(() {});
      final trickplay = await _api.mediaFileTrickplay(widget.mediaFileId);
      if (mounted && trickplay != null) setState(() => _trickplay = trickplay);
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  void _applyTracks(MediaFileTracksResponse tracks, int? audio) {
    setState(() {
      _subtitles = tracks.subtitles.where((t) => !t.requiresBurnIn).toList();
      _audioTracks = tracks.audio;
      _audioIndex = audio ?? pickAudio(tracks.audio, _prefs)?.streamIndex;
    });
    final sub = pickSubtitle(tracks.subtitles, _prefs);
    _selectSubtitle(sub, remember: false);
  }

  String _srcFor(StartPlaybackResponse start, {int cacheBust = 0}) {
    if (_isDirect(start.method)) return _api.resolve('/media-files/${widget.mediaFileId}/direct');
    final path = start.method == 'REMUX' && start.streamUrl != null ? start.streamUrl! : start.playlistUrl!;
    final url = _api.resolve(path);
    return cacheBust > 0 ? '$url${url.contains('?') ? '&' : '?'}r=$cacheBust' : url;
  }

  Future<void> _openMedia(String url, {int? initialSeekSec}) async {
    // libmpv fetches the stream itself (outside Dio): a fresh token as a raw header.
    String? access;
    try {
      access = await _api.warmToken();
    } catch (_) {
      access = ref.read(sessionProvider).accessToken;
    }
    await _player.open(Media(url, httpHeaders: access != null ? {'Authorization': 'Bearer $access'} : null), play: false);
    if (initialSeekSec != null && initialSeekSec > 0) {
      // libmpv needs the file open before a seek lands (vidstack's canplay-gated pending seek).
      await _player.stream.duration.firstWhere((d) => d > Duration.zero).timeout(const Duration(seconds: 10), onTimeout: () => Duration.zero);
      await _player.seek(Duration(seconds: initialSeekSec));
    }
    await _player.play();
  }

  /// A server-side restart started the stream at [actualStartMs] (null:
  /// exactly where asked; DIRECT: 0) — reopen it and land on [absoluteMs].
  Future<void> _reopen(int absoluteMs, int? actualStartMs) async {
    final newOffset = actualStartMs ?? absoluteMs;
    _timelineOffsetMs = newOffset;
    await _openMedia(_srcFor(_start!, cacheBust: DateTime.now().millisecondsSinceEpoch), initialSeekSec: ((absoluteMs - newOffset) / 1000).round());
    // REMUX/TRANSCODE sidecar subtitles are per-stream: re-attach after a reopen.
    if (!_isDirect(_start!.method) && _subtitle != null) await _selectSubtitle(_subtitle, remember: false);
  }

  /// Spinner over a server round-trip; any failure keeps what's playing.
  Future<void> _busy(Future<void> Function() body) async {
    setState(() => _restarting = true);
    try {
      await body();
    } catch (_) {
      // keep playing what we had
    } finally {
      if (mounted) setState(() => _restarting = false);
    }
  }

  // ── controls ───────────────────────────────────────────────────────────

  void _startHeartbeat() {
    _heartbeatTimer?.cancel();
    _heartbeatTimer = Timer.periodic(_heartbeatInterval, (_) {
      final sessionId = _start?.sessionId;
      if (sessionId == null) return;
      final durMs = _player.state.duration.inMilliseconds > 0 ? _player.state.duration.inMilliseconds + _timelineOffsetMs : null;
      _api.heartbeat(sessionId, positionMs: _absoluteMediaTimeMs, durationMs: durMs).catchError((_) {});
    });
  }

  Future<void> _seek(int targetMs, {bool fromParty = false}) async {
    final start = _start;
    if (start == null) return;
    if (!fromParty && (_party?.locked ?? false)) return;
    if (_isDirect(start.method)) {
      await _player.seek(Duration(milliseconds: targetMs));
    } else {
      // The server knows the encode frontier: it either says "already
      // covered" (local seek) or restarts ffmpeg at the target.
      await _busy(() async {
        final outcome = await _api.seek(start.sessionId, targetMs);
        if (outcome.restarted) {
          await _reopen(targetMs, outcome.actualStartMs);
        } else {
          await _player.seek(Duration(milliseconds: targetMs - _timelineOffsetMs));
        }
      });
    }
    final party = _party;
    if (!fromParty && party != null && party.isHost) unawaited(party.control(_player.state.playing ? 'PLAYING' : 'PAUSED', targetMs));
  }

  void _togglePlay() {
    _player.playOrPause();
    final party = _party;
    if (party != null && party.isHost) {
      // state after the toggle lands
      unawaited(party.control(_player.state.playing ? 'PAUSED' : 'PLAYING', _absoluteMediaTimeMs));
    }
  }

  Future<void> _selectAudio(int streamIndex) async {
    final start = _start;
    if (start == null) return;
    final track = _audioTracks.where((t) => t.streamIndex == streamIndex).firstOrNull;
    setState(() => _audioIndex = streamIndex);
    _prefs = _prefs.copyWith(audioLang: track?.lang);
    unawaited(_prefs.save());
    if (_isDirect(start.method)) {
      final native = _player.state.tracks.audio.where((t) => t.id == streamIndex.toString() || (track?.lang != null && t.language == track!.lang));
      if (native.isNotEmpty) await _player.setAudioTrack(native.first);
      return;
    }
    final pos = _absoluteMediaTimeMs;
    await _busy(() async => _reopen(pos, (await _api.switchAudioTrack(start.sessionId, streamIndex, pos)).actualStartMs));
  }

  Future<void> _selectQuality(QualityOption option) async {
    final start = _start;
    if (start == null) return;
    setState(() => _quality = option.label);
    _prefs = _prefs.copyWith(quality: option.label);
    unawaited(_prefs.save());
    final pos = _absoluteMediaTimeMs;
    await _busy(() async {
      final outcome = await _api.switchQuality(
        start.sessionId,
        positionMs: pos,
        reset: option.maxWidth == null,
        maxWidth: option.maxWidth,
        maxHeight: option.maxHeight,
        maxVideoBitrateKbps: option.maxVideoBitrateKbps,
      );
      // A quality switch can change the method (REMUX 1080p → TRANSCODE 480p, or back to DIRECT on reset).
      _start = StartPlaybackResponse(
        sessionId: start.sessionId,
        method: outcome.method,
        playlistUrl: outcome.playlistUrl,
        streamUrl: outcome.streamUrl,
        resumePositionMs: start.resumePositionMs,
        absoluteDurationMs: start.absoluteDurationMs,
        actualStartMs: outcome.actualStartMs,
      );
      await _reopen(pos, _isDirect(outcome.method) ? 0 : outcome.actualStartMs);
    });
  }

  Future<void> _selectSubtitle(SubtitleTrackInfo? track, {bool remember = true}) async {
    setState(() => _subtitle = track);
    if (remember) {
      _prefs = _prefs.copyWith(subtitleSet: true, subtitleLang: () => track?.lang, subtitleTitle: () => track?.title);
      unawaited(_prefs.save());
    }
    if (track == null) {
      await _player.setSubtitleTrack(SubtitleTrack.no());
      return;
    }
    final start = _start;
    if (start != null && _isDirect(start.method)) {
      // the container's own stream — libmpv lists it
      final native = _player.state.tracks.subtitle.where((t) => t.id != 'no' && t.id != 'auto' && ((t.title ?? '') == (track.title ?? '') && t.language == track.lang));
      final byLang = _player.state.tracks.subtitle.where((t) => t.language != null && t.language == track.lang);
      final hit = native.isNotEmpty ? native.first : (byLang.isNotEmpty ? byLang.first : null);
      if (hit != null) {
        await _player.setSubtitleTrack(hit);
        return;
      }
    }
    // REMUX/TRANSCODE carry no text subs: the server's extracted sidecar, in
    // memory (SubtitleTrack.uri can't send the bearer header).
    try {
      final text = await _api.subtitleText(widget.mediaFileId, track.id);
      await _player.setSubtitleTrack(SubtitleTrack.data(text, title: track.title ?? track.lang, language: track.lang));
    } catch (_) {
      // leave subtitles as they were
    }
  }

  // ── party / end ────────────────────────────────────────────────────────

  /// WAITING/PAUSED are a flat anchor; PLAYING advances with wall-clock since
  /// issuedAt — WatchPage.tsx's applyPartyCommand, simplified.
  Future<void> _applyPartyCommand(PartyCommand cmd) async {
    if (_start == null || _partyApplying) return;
    _partyApplying = true;
    try {
      final issuedAt = DateTime.tryParse(cmd.issuedAt) ?? DateTime.now();
      final target = cmd.state == 'PLAYING' ? cmd.positionMs + DateTime.now().difference(issuedAt).inMilliseconds.clamp(0, 1 << 30) : cmd.positionMs;
      if ((target - _absoluteMediaTimeMs).abs() > 3000) await _seek(target, fromParty: true);
      cmd.state == 'PLAYING' ? await _player.play() : await _player.pause();
    } finally {
      _partyApplying = false;
    }
  }

  void _onCompleted() {
    final next = _next;
    if (next == null || next.mediaFileId == null || _party != null || _upNextTimer != null) return;
    setState(() => _upNextCountdown = _upNextSeconds);
    _upNextTimer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted) return t.cancel();
      final left = (_upNextCountdown ?? 0) - 1;
      if (left <= 0) {
        t.cancel();
        _playNext();
      } else {
        setState(() => _upNextCountdown = left);
      }
    });
  }

  void _playNext() {
    final next = _next;
    if (next?.mediaFileId == null) return;
    context.pushReplacement('/watch/${next!.mediaFileId}?mediaItemId=${next.id}&series=${widget.seriesId}');
  }

  void _cancelUpNext() {
    _upNextTimer?.cancel();
    setState(() => _upNextCountdown = null);
  }

  // ── sheets ─────────────────────────────────────────────────────────────

  void _showTrackSheet() {
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (sheet) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.6,
        maxChildSize: 0.92,
        builder: (context, scroll) => ListView(
          controller: scroll,
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
          children: [
            if (_audioTracks.length > 1) ...[
              const _SheetLabel('Audio'),
              for (final t in _audioTracks)
                _OptionRow(
                  label: audioTrackLabel(t),
                  detail: t.codec?.toUpperCase(),
                  selected: _audioIndex == t.streamIndex,
                  onTap: () {
                    Navigator.pop(sheet);
                    _selectAudio(t.streamIndex);
                  },
                ),
            ],
            const _SheetLabel('Subtitles'),
            _OptionRow(
              label: 'Off',
              selected: _subtitle == null,
              onTap: () {
                Navigator.pop(sheet);
                _selectSubtitle(null);
              },
            ),
            for (final t in _subtitles)
              _OptionRow(
                label: [languageName(t.lang) ?? t.title ?? t.format.toUpperCase(), if (t.forced) 'forced', if (t.sdh) 'SDH'].join(' · '),
                detail: t.title != null && languageName(t.lang) != null ? t.title : null,
                selected: _subtitle?.id == t.id,
                onTap: () {
                  Navigator.pop(sheet);
                  _selectSubtitle(t);
                },
              ),
            const _SheetLabel('Quality'),
            for (final q in qualityOptions)
              _OptionRow(
                label: q.label,
                detail: q.maxVideoBitrateKbps != null ? '${(q.maxVideoBitrateKbps! / 1000).toStringAsFixed(1)} Mbps' : 'Best for this device',
                selected: _quality == q.label,
                onTap: () {
                  Navigator.pop(sheet);
                  _selectQuality(q);
                },
              ),
          ],
        ),
      ),
    );
  }

  void _showPartySheet() {
    final party = _party?.party;
    if (party == null) return;
    showModalBottomSheet<void>(
      context: context,
      builder: (sheet) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            const Text('Watch party', style: HokagoText.title),
            const SizedBox(height: 4),
            Text(_party!.isHost ? 'You are the host — everyone follows your play, pause and seeks.' : 'The host controls playback.', style: HokagoText.body),
            const SizedBox(height: 16),
            Pressable(
              onTap: () {
                Clipboard.setData(ClipboardData(text: party.inviteCode));
                ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Invite code copied')));
              },
              builder: (context, focused) => Container(
                padding: const EdgeInsets.symmetric(vertical: 16, horizontal: 20),
                decoration: BoxDecoration(color: HokagoColors.paper2, borderRadius: BorderRadius.circular(22), border: Border.all(color: focused ? HokagoColors.wii : HokagoColors.line)),
                child: Row(children: [
                  Expanded(child: Text(party.inviteCode, style: HokagoText.title.copyWith(letterSpacing: 5, color: HokagoColors.wiiInk))),
                  const HokagoIcon('copy', size: 20, color: HokagoColors.ink2),
                ]),
              ),
            ),
            const SizedBox(height: 18),
            for (final m in party.members)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 6),
                child: Row(children: [
                  Container(width: 8, height: 8, decoration: BoxDecoration(shape: BoxShape.circle, color: m.ready ? const Color(0xFF34D399) : HokagoColors.ink3)),
                  const SizedBox(width: 12),
                  Expanded(child: Text(m.name, style: HokagoText.cardTitle.copyWith(fontSize: 14.5))),
                  if (m.profileId == party.hostProfileId) const Text('host', style: HokagoText.small),
                ]),
              ),
          ]),
        ),
      ),
    );
  }

  // ── build ──────────────────────────────────────────────────────────────

  Widget? _preview(int absoluteMs) {
    final tp = _trickplay;
    if (tp == null) return null;
    final tile = trickplayTileAt(tp, absoluteMs);
    if (tile == null) return null;
    final token = ref.read(sessionProvider).accessToken;
    return LayoutBuilder(builder: (context, c) {
      final scaleX = c.maxWidth / tp.tileWidth, scaleY = c.maxHeight / tp.tileHeight;
      return ClipRect(
        child: OverflowBox(
          alignment: Alignment.topLeft,
          maxWidth: tp.tileWidth * tp.cols * scaleX,
          maxHeight: tp.tileHeight * tile.rows * scaleY,
          child: Transform.translate(
            offset: Offset(-tile.col * tp.tileWidth * scaleX, -tile.row * tp.tileHeight * scaleY),
            child: CachedNetworkImage(
              imageUrl: _api.resolve(tile.sheet.url),
              httpHeaders: token != null ? {'Authorization': 'Bearer $token'} : null,
              width: tp.tileWidth * tp.cols * scaleX,
              height: tp.tileHeight * tile.rows * scaleY,
              fit: BoxFit.fill,
              fadeInDuration: Duration.zero,
            ),
          ),
        ),
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    final start = _start;
    final party = _party;
    return Scaffold(
      backgroundColor: Colors.black,
      body: _failed
          ? _PlaybackError(onRetry: _startPlayback, onBack: () => context.pop())
          : start == null
              ? Stack(children: [
                  const Center(child: SizedBox(width: 44, height: 44, child: CircularProgressIndicator(strokeWidth: 3, color: Colors.white))),
                  Positioned(top: MediaQuery.paddingOf(context).top + 8, left: 12, child: GlassIconButton(icon: 'back', onPressed: () => context.pop())),
                ])
              : Stack(
                  fit: StackFit.expand,
                  children: [
                    Video(controller: _controller, controls: NoVideoControls, fill: Colors.black),
                    PlayerChrome(
                      player: _player,
                      title: _title,
                      subtitle: _subtitleLine,
                      offsetMs: _timelineOffsetMs,
                      durationMs: _absoluteDurationMs,
                      busy: _restarting,
                      locked: party?.locked ?? false,
                      onSeek: _seek,
                      onTogglePlay: _togglePlay,
                      onBack: () => context.pop(),
                      previewBuilder: _trickplay != null ? _preview : null,
                      actions: [
                        if (party?.party != null)
                          Padding(
                            padding: const EdgeInsets.only(left: 8),
                            child: WiiButton.ghost(compact: true, icon: 'users', label: '${party!.party!.members.length}', onPressed: _showPartySheet),
                          ),
                        const SizedBox(width: 8),
                        GlassIconButton(icon: 'cc', semanticLabel: 'Audio, subtitles and quality', onPressed: _showTrackSheet),
                      ],
                      overlay: _upNextCountdown != null && _next != null
                          ? _UpNextCard(episode: _next!, seconds: _upNextCountdown!, onPlay: _playNext, onCancel: _cancelUpNext)
                          : null,
                    ),
                  ],
                ),
    );
  }
}

/// WatchPage.tsx's AbsoluteTimeSlider hoverTile math: tile N lives on sheet
/// N ~/ tilesPerSheet at grid cell (N % tilesPerSheet) % cols / ~/ cols.
({TrickplaySheet sheet, int col, int row, int rows})? trickplayTileAt(MediaFileTrickplayResponse tp, int mediaMs) {
  final total = tp.sheets.fold<int>(0, (sum, s) => sum + s.tiles);
  if (total == 0 || tp.intervalMs <= 0) return null;
  final index = (mediaMs / tp.intervalMs).floor().clamp(0, total - 1);
  final sheetIndex = index ~/ tp.tilesPerSheet;
  if (sheetIndex >= tp.sheets.length) return null;
  final inSheet = index % tp.tilesPerSheet;
  return (sheet: tp.sheets[sheetIndex], col: inSheet % tp.cols, row: inSheet ~/ tp.cols, rows: (tp.tilesPerSheet / tp.cols).ceil());
}

class _SheetLabel extends StatelessWidget {
  const _SheetLabel(this.text);
  final String text;
  @override
  Widget build(BuildContext context) =>
      Padding(padding: const EdgeInsets.fromLTRB(6, 18, 6, 8), child: Text(text, style: HokagoText.meta.copyWith(color: HokagoColors.ink3, fontWeight: FontWeight.w700)));
}

class _OptionRow extends StatelessWidget {
  const _OptionRow({required this.label, required this.selected, required this.onTap, this.detail});
  final String label;
  final String? detail;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Pressable(
      onTap: onTap,
      pressedScale: 0.98,
      builder: (context, focused) => AnimatedContainer(
        duration: const Duration(milliseconds: 150),
        margin: const EdgeInsets.only(bottom: 4),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(16),
          color: selected ? HokagoColors.wii.withValues(alpha: 0.14) : (focused ? Colors.white.withValues(alpha: 0.06) : Colors.transparent),
          border: Border.all(color: focused ? HokagoColors.wii : Colors.transparent, width: 2),
        ),
        child: Row(children: [
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(label, style: HokagoText.cardTitle.copyWith(fontSize: 14.5, color: selected ? HokagoColors.wiiInk : HokagoColors.ink)),
              if (detail != null) Text(detail!, style: HokagoText.small),
            ]),
          ),
          if (selected) const HokagoIcon('check', size: 18, color: HokagoColors.wii),
        ]),
      ),
    );
  }
}

class _UpNextCard extends StatelessWidget {
  const _UpNextCard({required this.episode, required this.seconds, required this.onPlay, required this.onCancel});
  final EpisodeCard episode;
  final int seconds;
  final VoidCallback onPlay;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    final pad = MediaQuery.paddingOf(context);
    return Positioned(
      right: 20 + pad.right,
      bottom: 96 + pad.bottom,
      child: Container(
        width: 300,
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(color: HokagoColors.panelFill, borderRadius: BorderRadius.circular(24), border: Border.all(color: HokagoColors.panelBorder), boxShadow: hokagoPanelShadow),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
          Text('Up next in $seconds', style: HokagoText.small.copyWith(color: HokagoColors.wiiInk, fontWeight: FontWeight.w700)),
          const SizedBox(height: 4),
          Text(
            episode.episodeNumber != null ? 'S${episode.seasonNumber ?? 1} E${episode.episodeNumber} · ${episode.title}' : episode.title,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: HokagoText.cardTitle.copyWith(fontSize: 15),
          ),
          const SizedBox(height: 14),
          Row(children: [
            WiiButton(compact: true, icon: 'play', label: 'Play now', autofocus: true, onPressed: onPlay),
            const SizedBox(width: 8),
            WiiButton.ghost(compact: true, label: 'Cancel', onPressed: onCancel),
          ]),
        ]),
      ),
    );
  }
}

class _PlaybackError extends StatelessWidget {
  const _PlaybackError({required this.onRetry, required this.onBack});
  final VoidCallback onRetry;
  final VoidCallback onBack;

  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(28),
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            const HokagoIcon('alert', size: 40, color: HokagoColors.gold),
            const SizedBox(height: 16),
            Text("This one won't start right now", style: HokagoText.section.copyWith(color: Colors.white), textAlign: TextAlign.center),
            const SizedBox(height: 6),
            const Text('The server may be busy or unreachable. Try again in a moment.', style: TextStyle(color: Colors.white70), textAlign: TextAlign.center),
            const SizedBox(height: 22),
            Wrap(spacing: 10, children: [
              WiiButton(label: 'Try again', icon: 'refresh', autofocus: true, onPressed: onRetry),
              WiiButton.ghost(label: 'Back', icon: 'back', onPressed: onBack),
            ]),
          ]),
        ),
      );
}
