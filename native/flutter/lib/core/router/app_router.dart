import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../features/auth/login_screen.dart';
import '../../features/detail/detail_screen.dart';
import '../../features/home/home_screen.dart';
import '../../features/library/library_screen.dart';
import '../../features/onboarding/first_run_setup_screen.dart';
import '../../features/onboarding/server_setup_screen.dart';
import '../../features/player/player_screen.dart';
import '../../features/prefs/prefs_screen.dart';
import '../../features/profiles/profile_picker_screen.dart';
import '../../features/search/search_screen.dart';
import '../../features/downloads/downloads_screen.dart';
import '../../features/shell/app_shell.dart';
import '../session/session_controller.dart';
import '../session/session_state.dart';
import 'session_refresh_notifier.dart';

/// A pure geometric slide — position only, never opacity. An opacity-based
/// crossfade (tried first) blends the old and new page's content together
/// for the whole transition, which reads as "morphing" once every Scaffold
/// is transparent (to show the shared wallpaper) — at any instant during a
/// slide, each pixel shows only ONE page fully opaque, never a blend, so
/// there's nothing to morph. Subtle and quick (220ms), not the iOS default
/// (which also draws a drop shadow under the incoming page).
CustomTransitionPage<void> _slidePage(Widget child, GoRouterState state) {
  return CustomTransitionPage<void>(
    key: state.pageKey,
    child: child,
    transitionDuration: const Duration(milliseconds: 220),
    reverseTransitionDuration: const Duration(milliseconds: 220),
    transitionsBuilder: (context, animation, secondaryAnimation, child) {
      final offset = Tween<Offset>(begin: const Offset(0.08, 0), end: Offset.zero).animate(CurvedAnimation(parent: animation, curve: Curves.easeOutCubic));
      final fadeIn = CurvedAnimation(parent: animation, curve: const Interval(0.0, 0.6, curve: Curves.easeOut));
      return SlideTransition(position: offset, child: FadeTransition(opacity: fadeIn, child: child));
    },
  );
}

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
        case SessionStatus.needsProfile:
          return path == '/pick-profile' ? null : '/pick-profile';
        case SessionStatus.authenticated:
          const gates = {'/setup-server', '/setup', '/login', '/pick-profile'};
          return gates.contains(path) ? '/' : null;
      }
    },
    routes: [
      GoRoute(path: '/setup-server', pageBuilder: (_, state) => _slidePage(const ServerSetupScreen(), state)),
      GoRoute(path: '/setup', pageBuilder: (_, state) => _slidePage(const FirstRunSetupScreen(), state)),
      GoRoute(path: '/login', pageBuilder: (_, state) => _slidePage(const LoginScreen(), state)),
      GoRoute(path: '/pick-profile', pageBuilder: (_, state) => _slidePage(const ProfilePickerScreen(), state)),
      ShellRoute(
        builder: (context, state, child) => AppShell(child: child),
        routes: [
          GoRoute(path: '/', pageBuilder: (_, state) => _slidePage(const HomeScreen(), state)),
          GoRoute(
            path: '/library/:id',
            pageBuilder: (_, state) => _slidePage(LibraryScreen(libraryId: state.pathParameters['id']!), state),
          ),
          GoRoute(path: '/search', pageBuilder: (_, state) => _slidePage(const SearchScreen(), state)),
          GoRoute(path: '/downloads', pageBuilder: (_, state) => _slidePage(const DownloadsScreen(), state)),
          GoRoute(path: '/prefs', pageBuilder: (_, state) => _slidePage(const PrefsScreen(), state)),
        ],
      ),
      GoRoute(path: '/title/:id', pageBuilder: (_, state) => _slidePage(DetailScreen(itemId: state.pathParameters['id']!), state)),
      GoRoute(
        path: '/watch/:mediaFileId',
        pageBuilder: (_, state) => _slidePage(
          PlayerScreen(
            mediaFileId: state.pathParameters['mediaFileId']!,
            mediaItemId: state.uri.queryParameters['mediaItemId']!,
          ),
          state,
        ),
      ),
    ],
  );
}
