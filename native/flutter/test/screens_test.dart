import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:hokago/core/api/models/browse.dart';
import 'package:hokago/core/session/session_controller.dart';
import 'package:hokago/core/session/session_state.dart';
import 'package:hokago/core/theme/app_theme.dart';
import 'package:hokago/core/theme/hokago_background.dart';
import 'package:hokago/features/detail/detail_screen.dart';
import 'package:hokago/features/downloads/downloads_screen.dart';
import 'package:hokago/features/home/home_screen.dart';
import 'package:hokago/features/library/library_screen.dart';
import 'package:hokago/features/prefs/prefs_screen.dart';
import 'package:hokago/features/search/search_screen.dart';
import 'package:hokago/features/shell/app_shell.dart';

import 'fixtures.dart';

/// A signed-in session with no plugins or network behind it.
class _FakeSession extends SessionController {
  @override
  SessionState build() => const SessionState(
        status: SessionStatus.authenticated,
        serverUrl: 'http://hokago.test',
        profileId: 'p1',
        profileName: 'Rin',
        profiles: [ProfileOption(id: 'p1', name: 'Rin'), ProfileOption(id: 'p2', name: 'Mai')],
      );
}

Future<void> pumpScreen(WidgetTester tester, Widget screen, Size size, {String location = '/'}) async {
  tester.view.physicalSize = size * 3;
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  final router = GoRouter(initialLocation: location, routes: [
    ShellRoute(builder: (_, _, child) => AppShell(child: child), routes: [
      GoRoute(path: '/', builder: (_, _) => screen),
      GoRoute(path: '/title/:id', builder: (_, _) => const SizedBox()),
    ]),
    GoRoute(path: '/detail', builder: (_, _) => screen),
  ]);
  await tester.pumpWidget(ProviderScope(
    retry: (_, _) => null,
    overrides: [
      sessionProvider.overrideWith(_FakeSession.new),
      homeProvider.overrideWith((ref) async => homeFixture()),
      detailProvider.overrideWith((ref, id) async => seriesDetail()),
      librariesProvider.overrideWith((ref) async => [
            LibrarySummary(id: 'l1', name: 'Anime', contentProfile: 'ANIME', mediaKinds: ['SERIES']),
            LibrarySummary(id: 'l2', name: 'Movies', contentProfile: 'GENERAL', mediaKinds: ['MOVIE']),
          ]),
      searchIndexProvider.overrideWith((ref) async => [for (var i = 0; i < 20; i++) MediaCard.fromJson(card('s$i', title: 'Show number $i'))]),
      offlineEntriesProvider.overrideWith((ref) async => []),
    ],
    child: MaterialApp.router(theme: buildHokagoTheme(), builder: (_, child) => HokagoBackground(child: child!), routerConfig: router),
  ));
  // settle the data futures + entrance animations, without waiting on the
  // hero's endless auto-advance / skeleton shimmer
  for (var i = 0; i < 10; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

Finder richText(String part) => find.byWidgetPredicate((w) => w is RichText && w.text.toPlainText().contains(part));

void main() {
  const phone = Size(390, 844);
  const tv = Size(1280, 720);

  for (final (name, size) in [('phone', phone), ('tv', tv)]) {
    testWidgets('home renders on $name', (tester) async {
      await pumpScreen(tester, const HomeScreen(), size);
      expect(find.text('Continue watching'), findsWidgets);
      expect(find.text('Recently added'), findsWidgets);
      expect(find.text('Resume'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('detail renders on $name', (tester) async {
      await pumpScreen(tester, const DetailScreen(itemId: 'series1'), size, location: '/detail');
      expect(find.text('Continue S1 E2'), findsOneWidget);
      expect(richText('Season 1'), findsOneWidget);
      expect(richText('Season 2'), findsOneWidget);
      expect(richText('Movies'), findsOneWidget);
      await tester.scrollUntilVisible(richText('Frieren').last, 300, scrollable: find.byType(Scrollable).first);
      expect(tester.takeException(), isNull);
    });

    testWidgets('library tab renders on $name', (tester) async {
      await pumpScreen(tester, const LibrariesScreen(), size);
      expect(find.text('Anime'), findsWidgets);
      expect(find.text('Movies'), findsWidgets);
      expect(tester.takeException(), isNull);
    });

    testWidgets('search renders and filters on $name', (tester) async {
      await pumpScreen(tester, const SearchScreen(), size);
      expect(find.text('Try searching'), findsOneWidget);
      await tester.enterText(find.byType(TextField), 'number 1');
      await tester.pump();
      expect(find.textContaining('Results'), findsOneWidget);
      expect(find.text('Show number 1'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('settings + downloads render on $name', (tester) async {
      await pumpScreen(tester, const PrefsScreen(), size);
      expect(find.text('Switch profile'), findsOneWidget);
      await pumpScreen(tester, const DownloadsScreen(), size);
      expect(find.text('Nothing saved yet'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('home, detail and search survive large text (1.35x) on a small phone', (tester) async {
    tester.platformDispatcher.textScaleFactorTestValue = 1.35;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    const small = Size(360, 740);
    await pumpScreen(tester, const HomeScreen(), small);
    expect(tester.takeException(), isNull);
    await pumpScreen(tester, const DetailScreen(itemId: 'series1'), small, location: '/detail');
    expect(tester.takeException(), isNull);
    await pumpScreen(tester, const SearchScreen(), small);
    expect(tester.takeException(), isNull);
  });
}
