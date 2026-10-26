import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../features/auth/login_screen.dart';
import '../../features/boot/boot_screen.dart';
import '../../features/detail/detail_screen.dart';
import '../../features/devices/device_management_screen.dart';
import '../../features/downloads/downloads_screen.dart';
import '../../features/home/home_screen.dart';
import '../../features/library/library_screen.dart';
import '../../features/onboarding/first_run_setup_screen.dart';
import '../../features/onboarding/server_setup_screen.dart';
import '../../features/pair/approve_pair_screen.dart';
import '../../features/pair/pair_screen.dart';
import '../../features/party/party_join_screen.dart';
import '../../features/player/player_screen.dart';
import '../../features/prefs/prefs_screen.dart';
import '../../features/profiles/profile_picker_screen.dart';
import '../../features/search/search_screen.dart';
import '../../features/shell/app_shell.dart';
import '../platform.dart';
import '../session/session_controller.dart';
import '../session/session_state.dart';
import '../theme/app_theme.dart';
import 'session_refresh_notifier.dart';

/// Lateral tab switches: a quick fade-through, never a slide (both tabs'
/// full-opacity content overlapping mid-slide reads as "morphing").
CustomTransitionPage<void> _tabPage(Widget child, GoRouterState state) => CustomTransitionPage<void>(
      key: state.pageKey,
      child: child,
      transitionDuration: const Duration(milliseconds: 180),
      reverseTransitionDuration: const Duration(milliseconds: 180),
      transitionsBuilder: (context, animation, _, child) => FadeTransition(opacity: CurvedAnimation(parent: animation, curve: HokagoMotion.smooth), child: child),
    );

/// The gate screens (server, setup, login, profiles) cross-fade with a hint
/// of scale — the web's `zoomin` keyframe.
CustomTransitionPage<void> _gatePage(Widget child, GoRouterState state) => CustomTransitionPage<void>(
      key: state.pageKey,
      child: child,
      transitionDuration: const Duration(milliseconds: 380),
      transitionsBuilder: (context, animation, _, child) {
        final a = CurvedAnimation(parent: animation, curve: HokagoMotion.smooth);
        return FadeTransition(opacity: a, child: ScaleTransition(scale: Tween(begin: 0.94, end: 1.0).animate(a), child: child));
      },
    );

/// Drill-downs (title, library, player…) use the platform transition from
/// the theme — iOS swipe-back, Android predictive back.
MaterialPage<void> _page(Widget child, GoRouterState state) => MaterialPage<void>(key: state.pageKey, child: child);

const _gates = {'/boot', '/setup-server', '/setup', '/login', '/pair', '/pick-profile'};

/// Paths mirror apps/web/src/router.tsx (/, /library/:id, /title/:id,
/// /watch/:mediaFileId, /search, /downloads, /prefs, /party, /pair) so a
/// habit carried over from the web lands in the same place.
GoRouter buildAppRouter(Ref ref) {
  final refresh = SessionRefreshNotifier(ref);
  return GoRouter(
    refreshListenable: refresh,
    initialLocation: '/boot',
    redirect: (context, state) {
      final path = state.matchedLocation;
      String? only(String target) => path == target ? null : target;
      return switch (ref.read(sessionProvider).status) {
        SessionStatus.loading => only('/boot'),
        SessionStatus.needsServer => only('/setup-server'),
        SessionStatus.needsSetup => only('/setup'),
        // TVs can't comfortably type a password: pairing is their front door.
        SessionStatus.needsLogin => path == '/login' || path == '/pair' ? null : (isTvBuild ? '/pair' : '/login'),
        SessionStatus.needsProfile => only('/pick-profile'),
        SessionStatus.authenticated => _gates.contains(path) ? '/' : null,
      };
    },
    routes: [
      GoRoute(path: '/boot', pageBuilder: (_, state) => _gatePage(const BootScreen(), state)),
      GoRoute(path: '/setup-server', pageBuilder: (_, state) => _gatePage(const ServerSetupScreen(), state)),
      GoRoute(path: '/setup', pageBuilder: (_, state) => _gatePage(const FirstRunSetupScreen(), state)),
      GoRoute(path: '/login', pageBuilder: (_, state) => _gatePage(const LoginScreen(), state)),
      GoRoute(path: '/pair', pageBuilder: (_, state) => _gatePage(const PairScreen(), state)),
      GoRoute(path: '/pick-profile', pageBuilder: (_, state) => _gatePage(const ProfilePickerScreen(), state)),
      ShellRoute(
        builder: (context, state, child) => AppShell(child: child),
        routes: [
          GoRoute(path: '/', pageBuilder: (_, state) => _tabPage(const HomeScreen(), state)),
          GoRoute(path: '/libraries', pageBuilder: (_, state) => _tabPage(const LibrariesScreen(), state)),
          GoRoute(
            path: '/library/:id',
            pageBuilder: (_, state) => _page(LibraryScreen(libraryId: state.pathParameters['id']!, name: state.uri.queryParameters['name']), state),
          ),
          GoRoute(path: '/search', pageBuilder: (_, state) => _tabPage(const SearchScreen(), state)),
          GoRoute(path: '/downloads', pageBuilder: (_, state) => _tabPage(const DownloadsScreen(), state)),
          GoRoute(path: '/prefs', pageBuilder: (_, state) => _tabPage(const PrefsScreen(), state)),
        ],
      ),
      GoRoute(path: '/title/:id', pageBuilder: (_, state) => _page(DetailScreen(itemId: state.pathParameters['id']!), state)),
      GoRoute(path: '/party', pageBuilder: (_, state) => _page(const PartyJoinScreen(), state)),
      GoRoute(path: '/approve', pageBuilder: (_, state) => _page(const ApprovePairScreen(), state)),
      GoRoute(path: '/devices', pageBuilder: (_, state) => _page(const DeviceManagementScreen(), state)),
      GoRoute(
        path: '/watch/:mediaFileId',
        pageBuilder: (_, state) => _page(
          PlayerScreen(
            mediaFileId: state.pathParameters['mediaFileId']!,
            mediaItemId: state.uri.queryParameters['mediaItemId']!,
            partyId: state.uri.queryParameters['party'],
            audioStreamIndex: int.tryParse(state.uri.queryParameters['audio'] ?? ''),
            seriesId: state.uri.queryParameters['series'],
          ),
          state,
        ),
      ),
    ],
  );
}
