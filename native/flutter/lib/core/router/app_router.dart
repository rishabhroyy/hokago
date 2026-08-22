import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../features/auth/login_screen.dart';
import '../../features/detail/detail_screen.dart';
import '../../features/home/home_screen.dart';
import '../../features/library/library_screen.dart';
import '../../features/onboarding/first_run_setup_screen.dart';
import '../../features/onboarding/server_setup_screen.dart';
import '../../features/player/player_screen.dart';
import '../../features/search/search_screen.dart';
import '../../features/downloads/downloads_screen.dart';
import '../../features/shell/app_shell.dart';
import '../session/session_controller.dart';
import '../session/session_state.dart';
import 'session_refresh_notifier.dart';

/// Paths mirror apps/web/src/router.tsx 1:1 (/, /library/:id, /title/:id,
/// /watch/:mediaFileId, /search, /downloads) so a deep link or a habit
/// carried over from the web app lands in the same place.
GoRouter buildAppRouter(Ref ref) {
  final refresh = SessionRefreshNotifier(ref);
  return GoRouter(
    refreshListenable: refresh,
    initialLocation: '/',
    redirect: (context, state) {
      final session = ref.read(sessionProvider);
      final path = state.matchedLocation;
      switch (session.status) {
        case SessionStatus.loading:
          return null;
        case SessionStatus.needsServer:
          return path == '/setup-server' ? null : '/setup-server';
        case SessionStatus.needsSetup:
          return path == '/setup' ? null : '/setup';
        case SessionStatus.needsLogin:
          return path == '/login' ? null : '/login';
        case SessionStatus.authenticated:
          const gates = {'/setup-server', '/setup', '/login'};
          return gates.contains(path) ? '/' : null;
      }
    },
    routes: [
      GoRoute(path: '/setup-server', builder: (_, __) => const ServerSetupScreen()),
      GoRoute(path: '/setup', builder: (_, __) => const FirstRunSetupScreen()),
      GoRoute(path: '/login', builder: (_, __) => const LoginScreen()),
      ShellRoute(
        builder: (context, state, child) => AppShell(child: child),
        routes: [
          GoRoute(path: '/', builder: (_, __) => const HomeScreen()),
          GoRoute(path: '/library/:id', builder: (_, state) => LibraryScreen(libraryId: state.pathParameters['id']!)),
          GoRoute(path: '/search', builder: (_, __) => const SearchScreen()),
          GoRoute(path: '/downloads', builder: (_, __) => const DownloadsScreen()),
        ],
      ),
      GoRoute(path: '/title/:id', builder: (_, state) => DetailScreen(itemId: state.pathParameters['id']!)),
      GoRoute(
        path: '/watch/:mediaFileId',
        builder: (_, state) => PlayerScreen(
          mediaFileId: state.pathParameters['mediaFileId']!,
          mediaItemId: state.uri.queryParameters['mediaItemId']!,
        ),
      ),
    ],
  );
}
