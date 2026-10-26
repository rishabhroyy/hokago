import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../core/platform.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/hokago_icon.dart';
import '../../core/widgets/media_tile.dart';
import '../../core/widgets/pressable.dart';

class _Tab {
  const _Tab(this.path, this.icon, this.label);
  final String path;
  final String icon;
  final String label;
}

/// TV builds never offer downloads (product decision, docs/native-clients.md).
final _tabs = [
  const _Tab('/', 'home', 'Home'),
  const _Tab('/libraries', 'lib', 'Library'),
  const _Tab('/search', 'search', 'Search'),
  if (!isTvBuild) const _Tab('/downloads', 'download', 'Downloads'),
  const _Tab('/prefs', 'gear', 'Settings'),
];

/// Adaptive chrome around the browse screens. Phones: a frosted floating
/// bottom bar (the web's frosted-on-scroll nav, moved to the thumb) with the
/// glossy Wii pill on the current tab. Tablets / TV: the same pills as a
/// left rail — D-pad left reaches it from any screen.
class AppShell extends StatelessWidget {
  const AppShell({super.key, required this.child});
  final Widget child;

  static const barHeight = 64.0;

  int _indexFor(String location) {
    for (var i = _tabs.length - 1; i > 0; i--) {
      if (location.startsWith(_tabs[i].path)) return i;
    }
    if (location.startsWith('/library/')) return 1;
    return 0;
  }

  @override
  Widget build(BuildContext context) {
    final active = _indexFor(GoRouterState.of(context).matchedLocation);
    void go(int i) => context.go(_tabs[i].path);

    if (isWide(context) || isTvBuild) {
      return Scaffold(
        body: Row(
          children: [
            SafeArea(
              right: false,
              child: FocusTraversalGroup(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(16, 20, 4, 20),
                  child: Column(
                    children: [
                      const HokagoLogoMark(size: 34),
                      const SizedBox(height: 28),
                      for (var i = 0; i < _tabs.length; i++)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 8),
                          child: _TabPill(tab: _tabs[i], selected: i == active, vertical: true, onTap: () => go(i)),
                        ),
                    ],
                  ),
                ),
              ),
            ),
            Expanded(child: FocusTraversalGroup(child: child)),
          ],
        ),
      );
    }

    final bottomInset = MediaQuery.paddingOf(context).bottom;
    return Scaffold(
      extendBody: true,
      body: child,
      bottomNavigationBar: Padding(
        padding: EdgeInsets.fromLTRB(16, 0, 16, bottomInset > 0 ? bottomInset : 12),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(HokagoRadii.pill),
          child: BackdropFilter(
            filter: ImageFilter.blur(sigmaX: 24, sigmaY: 24),
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: HokagoColors.paper.withValues(alpha: 0.72),
                borderRadius: BorderRadius.circular(HokagoRadii.pill),
                border: Border.all(color: Colors.white.withValues(alpha: 0.08)),
              ),
              child: SizedBox(
                height: barHeight,
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 6),
                  child: Row(
                    children: [
                      for (var i = 0; i < _tabs.length; i++)
                        Expanded(child: _TabPill(tab: _tabs[i], selected: i == active, onTap: () => go(i))),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _TabPill extends StatelessWidget {
  const _TabPill({required this.tab, required this.selected, required this.onTap, this.vertical = false});
  final _Tab tab;
  final bool selected;
  final VoidCallback onTap;
  final bool vertical;

  @override
  Widget build(BuildContext context) {
    return Pressable(
      onTap: onTap,
      pressedScale: 0.9,
      semanticLabel: tab.label,
      builder: (context, focused) {
        final fg = selected ? Colors.white : (focused ? HokagoColors.ink : HokagoColors.ink3);
        return AnimatedContainer(
          duration: const Duration(milliseconds: 260),
          curve: HokagoMotion.snap,
          width: vertical ? 64 : null,
          height: vertical ? 56 : 50,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(vertical ? 20 : HokagoRadii.pill),
            gradient: selected ? const LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [HokagoColors.wiiBtnTop, HokagoColors.wiiBtnBottom]) : null,
            color: selected ? null : (focused ? Colors.white.withValues(alpha: 0.08) : Colors.transparent),
            boxShadow: focused ? hokagoWiiRing : (selected ? const [BoxShadow(color: Color(0x802E9BC4), blurRadius: 14, spreadRadius: -6, offset: Offset(0, 5))] : null),
          ),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              HokagoIcon(tab.icon, size: 20, color: fg),
              const SizedBox(height: 3),
              Text(tab.label, maxLines: 1, style: HokagoText.small.copyWith(fontSize: 10.5, fontWeight: FontWeight.w700, color: fg)),
            ],
          ),
        );
      },
    );
  }
}
