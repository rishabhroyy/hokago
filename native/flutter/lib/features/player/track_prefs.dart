import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';

import '../../core/api/models/media_files.dart';

/// track-prefs.ts, native: the "usual" audio language, subtitle choice and
/// quality, remembered across titles and applied as each file's default
/// (falling back to the file's own default when the remembered track
/// doesn't exist there). A small JSON file — not secret, not worth Keychain.
class TrackPrefs {
  const TrackPrefs({this.audioLang, this.subtitleSet = false, this.subtitleLang, this.subtitleTitle, this.quality});

  final String? audioLang;

  /// false = never picked (the file's first renderable track applies);
  /// true with a null lang+title = the user turned subtitles off.
  final bool subtitleSet;
  final String? subtitleLang;
  final String? subtitleTitle;
  final String? quality;

  bool get subtitlesOff => subtitleSet && subtitleLang == null && subtitleTitle == null;

  Map<String, dynamic> toJson() => {
        'audioLang': audioLang,
        'subtitleSet': subtitleSet,
        'subtitleLang': subtitleLang,
        'subtitleTitle': subtitleTitle,
        'quality': quality,
      };

  factory TrackPrefs.fromJson(Map<String, dynamic> j) => TrackPrefs(
        audioLang: j['audioLang'] as String?,
        subtitleSet: j['subtitleSet'] as bool? ?? false,
        subtitleLang: j['subtitleLang'] as String?,
        subtitleTitle: j['subtitleTitle'] as String?,
        quality: j['quality'] as String?,
      );

  TrackPrefs copyWith({String? audioLang, bool? subtitleSet, String? Function()? subtitleLang, String? Function()? subtitleTitle, String? quality}) => TrackPrefs(
        audioLang: audioLang ?? this.audioLang,
        subtitleSet: subtitleSet ?? this.subtitleSet,
        subtitleLang: subtitleLang != null ? subtitleLang() : this.subtitleLang,
        subtitleTitle: subtitleTitle != null ? subtitleTitle() : this.subtitleTitle,
        quality: quality ?? this.quality,
      );

  static Future<File> _file() async => File('${(await getApplicationSupportDirectory()).path}/hokago_track_prefs.json');

  static Future<TrackPrefs> load() async {
    try {
      return TrackPrefs.fromJson(jsonDecode(await (await _file()).readAsString()) as Map<String, dynamic>);
    } catch (_) {
      return const TrackPrefs();
    }
  }

  Future<void> save() async {
    try {
      final f = await _file();
      await f.parent.create(recursive: true);
      await f.writeAsString(jsonEncode(toJson()));
    } catch (_) {
      // a preference failing to persist never blocks playback
    }
  }
}

/// The remembered audio language, else the file's default track.
MediaFileAudioTrackInfo? pickAudio(List<MediaFileAudioTrackInfo> tracks, TrackPrefs prefs) {
  if (tracks.isEmpty) return null;
  final lang = prefs.audioLang;
  if (lang != null) {
    for (final t in tracks) {
      if (t.lang == lang) return t;
    }
  }
  for (final t in tracks) {
    if (t.isDefault) return t;
  }
  return tracks.first;
}

/// Subtitles: off if the user turned them off; the remembered track (title
/// + language, then language alone) if this file has it; otherwise the
/// file's first renderable track — so a subs-only anime never starts silent
/// to a non-speaker just because no choice was ever made.
SubtitleTrackInfo? pickSubtitle(List<SubtitleTrackInfo> tracks, TrackPrefs prefs) {
  final renderable = tracks.where((t) => !t.requiresBurnIn).toList();
  if (renderable.isEmpty || prefs.subtitlesOff) return null;
  if (prefs.subtitleSet) {
    for (final t in renderable) {
      if (t.lang == prefs.subtitleLang && t.title == prefs.subtitleTitle) return t;
    }
    for (final t in renderable) {
      if (t.lang != null && t.lang == prefs.subtitleLang) return t;
    }
  }
  return renderable.first;
}
