import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/theme/app_theme.dart';

/// Bottom-tab shell for the three top-level destinations. Library switching
/// (web's TopNav library dropdown) lives inside HomeScreen for v1 — see
/// docs/native-clients.md follow-ups for a dedicated library tab if the
/// account has many libraries.
class AppShell extends StatelessWidget {
  const AppShell({super.key, required this.child});
  final Widget child;

  static const _tabs = ['/', '/search', '/downloads'];

  int _indexFor(String location) {
    if (location.startsWith('/search')) return 1;
    if (location.startsWith('/downloads')) return 2;
    return 0;
  }

  @override
  Widget build(BuildContext context) {
    final location = GoRouterState.of(context).matchedLocation;
    final index = _indexFor(location);
    return Scaffold(
      body: child,
      bottomNavigationBar: NavigationBar(
        selectedIndex: index,
        backgroundColor: HokagoColors.paper,
        indicatorColor: HokagoColors.accent.withValues(alpha: 0.18),
        onDestinationSelected: (i) => context.go(_tabs[i]),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.home_outlined), selectedIcon: Icon(Icons.home_rounded), label: 'Home'),
          NavigationDestination(icon: Icon(Icons.search_outlined), selectedIcon: Icon(Icons.search_rounded), label: 'Search'),
          NavigationDestination(
              icon: Icon(Icons.download_outlined), selectedIcon: Icon(Icons.download_rounded), label: 'Downloads'),
        ],
      ),
    );
  }
}
