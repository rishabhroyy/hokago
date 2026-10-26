import 'package:flutter_test/flutter_test.dart';
import 'package:hokago/core/api/models/browse.dart';
import 'package:hokago/core/api/models/media_files.dart';
import 'package:hokago/core/session/session_controller.dart';
import 'package:hokago/core/widgets/media_tile.dart';
import 'package:hokago/features/detail/detail_screen.dart';
import 'package:hokago/features/library/library_screen.dart';
import 'package:hokago/features/player/player_screen.dart';
import 'package:hokago/features/player/track_prefs.dart';
import 'package:hokago/features/search/search_screen.dart';

import 'fixtures.dart';

SubtitleTrackInfo sub(String id, String? lang, {String? title, bool burn = false}) =>
    SubtitleTrackInfo(id: id, lang: lang, title: title, format: 'ass', forced: false, sdh: false, requiresBurnIn: burn);

void main() {
  test('server URL: explicit scheme wins, LAN gets http, domains get https', () {
    expect(normalizeServerUrl('https://x.lan/'), 'https://x.lan');
    expect(normalizeServerUrl('192.168.1.20:3000'), 'http://192.168.1.20:3000');
    expect(normalizeServerUrl(' localhost:3000 '), 'http://localhost:3000');
    expect(normalizeServerUrl('nas'), 'http://nas');
    expect(normalizeServerUrl('box.local:3000'), 'http://box.local:3000');
    expect(normalizeServerUrl('hokago.example.com'), 'https://hokago.example.com');
  });

  test('search: prefix matches first, then containment, case-insensitive', () {
    final index = [for (final t in ['The Frieren Movie', 'Frieren', 'Spy x Family', 'frieren 2']) MediaCard.fromJson(card(t, title: t))];
    expect(rankSearch(index, 'FRIE').map((c) => c.title), ['Frieren', 'frieren 2', 'The Frieren Movie']);
    expect(rankSearch(index, '  '), isEmpty);
  });

  test('next episode: in-progress, else first unwatched, else first', () {
    expect(nextEpisodeOf(seriesDetail())!.id, 'e2');
    final allWatched = seriesDetail(episodes: [episode('a', 1, watched: true), episode('b', 2, watched: true)]);
    expect(nextEpisodeOf(allWatched)!.id, 'a');
    expect(nextEpisodeOf(seriesDetail(episodes: []))!.id, 'm1');
  });

  test('up next follows series order into the movies, null at the end', () {
    final s = seriesDetail();
    expect(nextEpisodeAfter(s, 'e3')!.id, 's2e1');
    expect(nextEpisodeAfter(s, 's2e1')!.id, 'm1');
    expect(nextEpisodeAfter(s, 'm1'), isNull);
    expect(nextEpisodeAfter(s, 'unknown'), isNull);
  });

  test('subtitles: unset → first renderable, off → none, remembered → by title+lang then lang', () {
    final tracks = [sub('pgs', 'eng', burn: true), sub('a', 'eng', title: 'Signs'), sub('b', 'eng', title: 'Full'), sub('c', 'spa')];
    expect(pickSubtitle(tracks, const TrackPrefs())!.id, 'a');
    expect(pickSubtitle(tracks, const TrackPrefs(subtitleSet: true)), isNull);
    expect(pickSubtitle(tracks, const TrackPrefs(subtitleSet: true, subtitleLang: 'eng', subtitleTitle: 'Full'))!.id, 'b');
    expect(pickSubtitle(tracks, const TrackPrefs(subtitleSet: true, subtitleLang: 'spa', subtitleTitle: 'x'))!.id, 'c');
    expect(pickSubtitle([sub('pgs', 'eng', burn: true)], const TrackPrefs()), isNull);
  });

  test('audio: remembered language, else default flag, else first', () {
    MediaFileAudioTrackInfo a(int i, String lang, {bool def = false}) => MediaFileAudioTrackInfo(streamIndex: i, codec: 'aac', lang: lang, title: null, isDefault: def);
    final tracks = [a(1, 'jpn'), a(2, 'eng', def: true)];
    expect(pickAudio(tracks, const TrackPrefs(audioLang: 'jpn'))!.streamIndex, 1);
    expect(pickAudio(tracks, const TrackPrefs(audioLang: 'fre'))!.streamIndex, 2);
    expect(pickAudio([a(3, 'kor')], const TrackPrefs())!.streamIndex, 3);
    expect(pickAudio(const [], const TrackPrefs()), isNull);
  });

  test('trickplay tile math matches the web scrubber', () {
    final tp = MediaFileTrickplayResponse(tileWidth: 320, tileHeight: 180, intervalMs: 10000, tilesPerSheet: 25, cols: 5, sheets: [
      TrickplaySheet(index: 0, url: '/a', tiles: 25),
      TrickplaySheet(index: 1, url: '/b', tiles: 10),
    ]);
    final t0 = trickplayTileAt(tp, 0)!;
    expect((t0.sheet.url, t0.col, t0.row), ('/a', 0, 0));
    final t = trickplayTileAt(tp, 270000)!; // tile 27 → sheet 1, cell 2
    expect((t.sheet.url, t.col, t.row, t.rows), ('/b', 2, 0, 5));
    expect(trickplayTileAt(tp, 99999999)!.sheet.url, '/b'); // clamps to the last tile
  });

  test('continue-watching tiles: landscape, series detail, progress vs up next', () {
    final t = continueWatchingToTile(cwEntry());
    expect((t.landscape, t.detailId, t.posterUrl, t.subLabel), (true, 'series1', '/art/b.jpg', 'S1 E2, Frieren'));
    expect(t.progress, closeTo(0.25, 1e-9));
    final next = continueWatchingToTile(cwEntry(upNext: true));
    expect((next.badge, next.progress), ('Up next', null));
  });

  test('library order floats downloaded titles first, stable within groups', () {
    final sorted = stableSort([1, 2, 3, 4, 5, 6], (a, b) => (a.isEven ? 0 : 1) - (b.isEven ? 0 : 1));
    expect(sorted, [2, 4, 6, 1, 3, 5]);
  });

  test('quality ladder keeps Original first (the reset option)', () {
    expect(qualityOptions.first.maxWidth, isNull);
  });
}
