import 'package:hokago/core/api/models/browse.dart';
import 'package:hokago/core/api/models/home.dart';
import 'package:hokago/core/api/models/playback.dart';

Map<String, dynamic> card(String id, {String kind = 'MOVIE', String? title, bool downloaded = true}) => {
      'id': id,
      'kind': kind,
      'title': title ?? 'Title $id',
      'sortTitle': title ?? 'Title $id',
      'year': 2024,
      'posterUrl': null,
      'backdropUrl': null,
      'mediaFileId': 'file-$id',
      'isDownloaded': downloaded,
      'genres': ['Drama'],
    };

Map<String, dynamic> episode(String id, int ep, {int season = 1, bool watched = false, int positionMs = 0}) => {
      ...card(id, kind: 'EPISODE', title: 'Episode $ep — a long enough title to ellipsize on a phone'),
      'seasonNumber': season,
      'episodeNumber': ep,
      'runtimeMs': 24 * 60000,
      'watched': watched,
      'positionMs': positionMs,
    };

MediaItemDetail seriesDetail({List<Map<String, dynamic>>? episodes}) => MediaItemDetail.fromJson({
      ...card('series1', kind: 'SERIES', title: 'Frieren: Beyond Journey’s End'),
      'mediaFileId': null,
      'overview': 'An elf mage <i>outlives</i> her party.<br>Then sets out again.',
      'originalTitle': 'Sousou no Frieren',
      'rating': 9.1,
      'studio': 'Madhouse',
      'children': [],
      'episodes': episodes ??
          [
            episode('e1', 1, watched: true),
            episode('e2', 2, positionMs: 60000),
            episode('e3', 3),
            episode('s2e1', 1, season: 2),
          ],
      'movies': [episode('m1', 0)..['kind'] = 'MOVIE'],
      'audioTracks': [
        {'streamIndex': 1, 'lang': 'jpn'},
        {'streamIndex': 2, 'lang': 'eng'},
      ],
      'bitrateKbps': 6200,
      'bitrateQuality': 'good',
      'watch': null,
      'externalIds': [
        {'provider': 'ANILIST', 'providerId': '154587'},
      ],
      'collections': [
        {
          'id': 'c1',
          'name': 'Frieren',
          'kind': 'FRANCHISE',
          'posterUrl': null,
          'relationType': 'SEQUEL',
          'entries': [
            {'relationType': 'SEQUEL', 'anchor': null, 'item': card('series2', kind: 'SERIES')},
          ],
        },
      ],
    });

HomeResponse homeFixture() => HomeResponse.fromJson({
      'continueWatching': [
        {
          'mediaItem': {
            'id': 'e2',
            'kind': 'EPISODE',
            'title': 'Episode 2',
            'parentId': 'season1',
            'seasonNumber': 1,
            'episodeNumber': 2,
            'year': 2024,
            'posterUrl': null,
            'backdropUrl': null,
            'mediaFileId': 'file-e2',
          },
          'seriesTitle': 'Frieren',
          'detailItemId': 'series1',
          'positionMs': 600000,
          'durationMs': 1440000,
          'upNext': false,
        },
      ],
      'slides': [
        {
          'kind': 'CONTINUE',
          'label': 'Continue watching',
          'title': 'Frieren: Beyond Journey’s End',
          'sub': 'S1 E2',
          'year': 2023,
          'posterUrl': null,
          'backdropUrl': null,
          'progress': 0.4,
          'timeLeftLabel': '14m left',
          'detailId': 'series1',
          'mediaItemId': 'e2',
          'mediaFileId': 'file-e2',
        },
        {
          'kind': 'RECENTLY_ADDED',
          'label': 'Recently added',
          'title': 'Perfect Days',
          'sub': null,
          'year': 2023,
          'posterUrl': null,
          'backdropUrl': null,
          'progress': null,
          'timeLeftLabel': null,
          'detailId': 'movie1',
          'mediaItemId': 'movie1',
          'mediaFileId': 'file-movie1',
        },
      ],
      'rows': [
        {'id': 'recent', 'title': 'Recently added', 'subtitle': null, 'items': [for (var i = 0; i < 8; i++) card('r$i', downloaded: i != 3)]},
        {'id': 'genre:drama', 'title': 'Drama', 'subtitle': null, 'items': [for (var i = 0; i < 5; i++) card('d$i')]},
      ],
    });

ContinueWatchingEntry cwEntry({bool upNext = false}) => ContinueWatchingEntry.fromJson({
      'mediaItem': {
        'id': 'e2',
        'kind': 'EPISODE',
        'title': 'Episode 2',
        'parentId': 'season1',
        'seasonNumber': 1,
        'episodeNumber': 2,
        'year': null,
        'posterUrl': '/art/p.jpg',
        'backdropUrl': '/art/b.jpg',
        'mediaFileId': 'f',
      },
      'seriesTitle': 'Frieren',
      'detailItemId': 'series1',
      'positionMs': 300000,
      'durationMs': 1200000,
      'upNext': upNext,
    });
