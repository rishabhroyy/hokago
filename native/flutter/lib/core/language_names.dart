import 'api/models/media_files.dart';

// ffprobe tags are ISO 639-2/B ("eng", "jpn"), sometimes 639-1 ("en").
// ponytail: a table of the languages media actually ships with, not all of
// ISO 639 — unknown codes fall back to the raw tag. The web uses
// Intl.DisplayNames; Dart has no built-in equivalent without package:intl data.
const _names = {
  'eng': 'English', 'en': 'English', 'jpn': 'Japanese', 'ja': 'Japanese', 'spa': 'Spanish', 'es': 'Spanish',
  'fre': 'French', 'fra': 'French', 'fr': 'French', 'ger': 'German', 'deu': 'German', 'de': 'German',
  'ita': 'Italian', 'it': 'Italian', 'por': 'Portuguese', 'pt': 'Portuguese', 'rus': 'Russian', 'ru': 'Russian',
  'chi': 'Chinese', 'zho': 'Chinese', 'zh': 'Chinese', 'kor': 'Korean', 'ko': 'Korean', 'ara': 'Arabic', 'ar': 'Arabic',
  'hin': 'Hindi', 'hi': 'Hindi', 'dut': 'Dutch', 'nld': 'Dutch', 'nl': 'Dutch', 'swe': 'Swedish', 'sv': 'Swedish',
  'nor': 'Norwegian', 'nob': 'Norwegian', 'no': 'Norwegian', 'dan': 'Danish', 'da': 'Danish', 'fin': 'Finnish', 'fi': 'Finnish',
  'pol': 'Polish', 'pl': 'Polish', 'tur': 'Turkish', 'tr': 'Turkish', 'gre': 'Greek', 'ell': 'Greek', 'el': 'Greek',
  'heb': 'Hebrew', 'he': 'Hebrew', 'tha': 'Thai', 'th': 'Thai', 'vie': 'Vietnamese', 'vi': 'Vietnamese',
  'ind': 'Indonesian', 'id': 'Indonesian', 'may': 'Malay', 'msa': 'Malay', 'ms': 'Malay', 'cze': 'Czech', 'ces': 'Czech', 'cs': 'Czech',
  'hun': 'Hungarian', 'hu': 'Hungarian', 'rum': 'Romanian', 'ron': 'Romanian', 'ro': 'Romanian', 'ukr': 'Ukrainian', 'uk': 'Ukrainian',
  'tam': 'Tamil', 'ta': 'Tamil', 'tel': 'Telugu', 'te': 'Telugu', 'fil': 'Filipino', 'tgl': 'Tagalog', 'cat': 'Catalan', 'ca': 'Catalan',
};

/// Human-readable language name for a tag, or null when it can't be resolved.
String? languageName(String? code) => code == null ? null : _names[code.trim().toLowerCase()];

/// language-names.ts's audioTrackLabel: the language name when the mux title
/// is just the codec echoing itself ("Opus 2.0"), else the meaningful title
/// prefixed by the language when distinct ("Japanese · Commentary").
String audioTrackLabel(MediaFileAudioTrackInfo t) {
  final name = languageName(t.lang);
  final title = t.title?.trim();
  if (title == null || title.isEmpty) return name ?? t.lang ?? 'Track ${t.streamIndex}';
  if (t.codec != null && title.toLowerCase().startsWith(t.codec!.trim().toLowerCase())) return name ?? title;
  if (name != null && !title.toLowerCase().startsWith(name.toLowerCase())) return '$name · $title';
  return title;
}
