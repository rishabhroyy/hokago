import 'package:flutter/material.dart';
import 'package:media_kit/media_kit.dart';
import 'package:media_kit_video/media_kit_video.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../../core/theme/app_theme.dart';

/// Plays a saved download straight off disk — no server, no auth headers,
/// no playback/start session (there's nothing server-side to decide; the
/// file on disk *is* the stream). This was a real gap: downloads could be
/// created and deleted but never actually played back offline.
class OfflineWatchScreen extends StatefulWidget {
  const OfflineWatchScreen({super.key, required this.localPath, required this.title});
  final String localPath;
  final String title;

  @override
  State<OfflineWatchScreen> createState() => _OfflineWatchScreenState();
}

class _OfflineWatchScreenState extends State<OfflineWatchScreen> {
  late final Player _player = Player();
  late final VideoController _controller = VideoController(_player);
  bool _controlsVisible = true;

  @override
  void initState() {
    super.initState();
    WakelockPlus.enable();
    _player.open(Media('file://${widget.localPath}'));
  }

  @override
  void dispose() {
    WakelockPlus.disable();
    _player.dispose();
    super.dispose();
  }

  String _fmt(Duration d) {
    final s = d.inSeconds;
    final h = s ~/ 3600, m = (s % 3600) ~/ 60, sec = s % 60;
    final mm = h > 0 ? m.toString().padLeft(2, '0') : '$m';
    return h > 0 ? '$h:$mm:${sec.toString().padLeft(2, '0')}' : '$mm:${sec.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      body: GestureDetector(
        onTap: () => setState(() => _controlsVisible = !_controlsVisible),
        child: Stack(
          fit: StackFit.expand,
          children: [
            Center(child: Video(controller: _controller, controls: NoVideoControls)),
            AnimatedOpacity(
              opacity: _controlsVisible ? 1 : 0,
              duration: const Duration(milliseconds: 180),
              child: IgnorePointer(
                ignoring: !_controlsVisible,
                child: DecoratedBox(
                  decoration: const BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.topCenter,
                      end: Alignment.bottomCenter,
                      colors: [Colors.black54, Colors.transparent, Colors.transparent, Colors.black87],
                      stops: [0, 0.25, 0.6, 1],
                    ),
                  ),
                  child: Column(
                    children: [
                      SafeArea(
                        child: Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 8),
                          child: Row(
                            children: [
                              IconButton(onPressed: () => Navigator.of(context).maybePop(), icon: const Icon(Icons.arrow_back_rounded, color: Colors.white)),
                              Expanded(
                                child: Text(widget.title, maxLines: 1, overflow: TextOverflow.ellipsis, style: HokagoText.cardTitle.copyWith(color: Colors.white)),
                              ),
                              const Icon(Icons.wifi_off_rounded, color: Colors.white54, size: 18),
                              const SizedBox(width: 16),
                            ],
                          ),
                        ),
                      ),
                      const Spacer(),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          IconButton(
                            iconSize: 36,
                            color: Colors.white,
                            onPressed: () => _player.seek(_player.state.position - const Duration(seconds: 10)),
                            icon: const Icon(Icons.replay_10_rounded),
                          ),
                          const SizedBox(width: 24),
                          StreamBuilder<bool>(
                            stream: _player.stream.playing,
                            initialData: _player.state.playing,
                            builder: (_, snap) => IconButton(
                              iconSize: 56,
                              color: Colors.white,
                              onPressed: () => _player.playOrPause(),
                              icon: Icon(snap.data == true ? Icons.pause_rounded : Icons.play_arrow_rounded),
                            ),
                          ),
                          const SizedBox(width: 24),
                          IconButton(
                            iconSize: 36,
                            color: Colors.white,
                            onPressed: () => _player.seek(_player.state.position + const Duration(seconds: 10)),
                            icon: const Icon(Icons.forward_10_rounded),
                          ),
                        ],
                      ),
                      const Spacer(),
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 0, 16, 20),
                        child: StreamBuilder<Duration>(
                          stream: _player.stream.position,
                          initialData: Duration.zero,
                          builder: (_, posSnap) {
                            final pos = posSnap.data ?? Duration.zero;
                            final dur = _player.state.duration;
                            final ratio = dur.inMilliseconds > 0 ? pos.inMilliseconds / dur.inMilliseconds : 0.0;
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
                                  child: Slider(value: ratio.clamp(0.0, 1.0), onChanged: (v) => _player.seek(dur * v)),
                                ),
                                Row(
                                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                                  children: [
                                    Text(_fmt(pos), style: const TextStyle(color: Colors.white70, fontSize: 12)),
                                    Text(_fmt(dur), style: const TextStyle(color: Colors.white70, fontSize: 12)),
                                  ],
                                ),
                              ],
                            );
                          },
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
