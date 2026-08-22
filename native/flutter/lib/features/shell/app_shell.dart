import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/theme/app_theme.dart';
import '../../core/widgets/hokago_panel.dart';

/// Floating pill tab bar — hokago has no bottom-nav precedent on the web
/// (desktop uses a top nav), so this is a mobile-native addition, but built
/// from the same visual language as everything else: a HokagoPanel-style
/// frosted floating bar, and the active tab rendered as a glossy wii-blue
/// pill (the same gradient WiiButton uses) instead of a flat Material
/// indicator. Library switching (web's TopNav dropdown) lives inside
/// HomeScreen for v1 — see docs/native-clients.md follow-ups for a
/// dedicated library tab if the account has many libraries.
class AppShell extends StatelessWidget {
  const AppShell({super.key, required this.child});
  final Widget child;

  static const _tabs = ['/', '/search', '/downloads'];
  static const _icons = [Icons.home_rounded, Icons.search_rounded, Icons.download_rounded];
  static const _labels = ['Home', 'Search', 'Downloads'];

  int _indexFor(String location) {
    if (location.startsWith('/search')) return 1;
    if (location.startsWith('/downloads')) return 2;
    return 0;
  }

  @override
  Widget build(BuildContext context) {
    final location = GoRouterState.of(context).matchedLocation;
    final active = _indexFor(location);
    return Scaffold(
      extendBody: true,
      body: child,
      bottomNavigationBar: SafeArea(
        minimum: const EdgeInsets.fromLTRB(20, 0, 20, 14),
        child: HokagoPanel(
          borderRadius: HokagoRadii.pill,
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 10),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              for (var i = 0; i < _tabs.length; i++)
                _TabItem(
                  icon: _icons[i],
                  label: _labels[i],
                  selected: i == active,
                  onTap: () => context.go(_tabs[i]),
                ),
            ],
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
    return GestureDetector(
      onTap: onTap,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 200),
        curve: Curves.easeOut,
        padding: EdgeInsets.symmetric(horizontal: selected ? 18 : 12, vertical: 10),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(HokagoRadii.pill),
          gradient: selected
              ? const LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [HokagoColors.wiiBtnTop, HokagoColors.wiiBtnBottom])
              : null,
          boxShadow: selected ? const [BoxShadow(color: Color(0x662E9BC4), blurRadius: 12, offset: Offset(0, 4), spreadRadius: -4)] : null,
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 22, color: selected ? Colors.white : HokagoColors.ink3),
            if (selected) ...[
              const SizedBox(width: 8),
              Text(label, style: const TextStyle(fontFamily: 'Plus Jakarta Sans', color: Colors.white, fontSize: 13.5, fontWeight: FontWeight.w700)),
            ],
          ],
        ),
      ),
    );
  }
}
