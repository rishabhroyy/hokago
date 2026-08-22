import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/theme/app_theme.dart';

/// Bottom tab bar — hokago has no bottom-nav precedent on the web (desktop
/// uses a top nav), so this is a mobile-native addition. A conventional
/// full-width bar (equal-width tabs, label always visible, selected tab
/// picked out by a small wii-blue icon badge) reads far less "weird" than
/// the earlier floating-pill experiment, whose variable tab widths made the
/// bar visibly shift/resize on every tap. Library switching (web's TopNav
/// dropdown) lives inside HomeScreen for v1 — see docs/native-clients.md
/// follow-ups for a dedicated library tab if the account has many libraries.
class AppShell extends StatelessWidget {
  const AppShell({super.key, required this.child});
  final Widget child;

  static const _tabs = ['/', '/search', '/downloads', '/prefs'];
  static const _icons = [Icons.home_rounded, Icons.search_rounded, Icons.download_rounded, Icons.settings_rounded];
  static const _labels = ['Home', 'Search', 'Downloads', 'Settings'];

  int _indexFor(String location) {
    if (location.startsWith('/search')) return 1;
    if (location.startsWith('/downloads')) return 2;
    if (location.startsWith('/prefs')) return 3;
    return 0;
  }

  @override
  Widget build(BuildContext context) {
    final location = GoRouterState.of(context).matchedLocation;
    final active = _indexFor(location);
    return Scaffold(
      body: SafeArea(bottom: false, child: child),
      bottomNavigationBar: DecoratedBox(
        decoration: BoxDecoration(
          color: HokagoColors.paper,
          border: Border(top: BorderSide(color: HokagoColors.line)),
        ),
        child: SafeArea(
          top: false,
          child: SizedBox(
            height: 60,
            child: Row(
              children: [
                for (var i = 0; i < _tabs.length; i++)
                  Expanded(
                    child: _TabItem(
                      icon: _icons[i],
                      label: _labels[i],
                      selected: i == active,
                      onTap: () => context.go(_tabs[i]),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _TabItem extends StatelessWidget {
  const _TabItem({required this.icon, required this.label, required this.selected, required this.onTap});
  final IconData icon;
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 4),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(HokagoRadii.pill),
              color: selected ? HokagoColors.wii.withValues(alpha: 0.16) : Colors.transparent,
            ),
            child: Icon(icon, size: 22, color: selected ? HokagoColors.wiiDeep : HokagoColors.ink3),
          ),
          const SizedBox(height: 3),
          Text(
            label,
            style: TextStyle(
              fontFamily: 'Plus Jakarta Sans',
              fontSize: 11,
              fontWeight: selected ? FontWeight.w700 : FontWeight.w600,
              color: selected ? HokagoColors.wiiDeep : HokagoColors.ink3,
            ),
          ),
        ],
      ),
    );
  }
}
