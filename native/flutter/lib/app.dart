import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/router/app_router.dart';
import 'core/theme/app_theme.dart';
import 'core/theme/hokago_background.dart';
import 'core/theme/theme_mode_controller.dart';

class HokagoApp extends ConsumerWidget {
  const HokagoApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(_routerProvider);
    // Watching (not reading) themeModeProvider is what makes a toggle
    // rebuild the whole tree with the new HokagoColors palette — the
    // getters themselves aren't reactive, this widget rebuilding is what
    // forces every descendant to re-read them.
    final isDark = ref.watch(themeModeProvider);
    return MaterialApp.router(
      key: ValueKey(isDark),
      title: 'hokago',
      debugShowCheckedModeBanner: false,
      theme: buildHokagoTheme(),
      // The "wii-dream" wallpaper (app.css body::before) painted once behind
      // every route, so every Scaffold can go transparent and let it show.
      builder: (context, child) => HokagoBackground(child: child!),
      routerConfig: router,
    );
  }
}

final _routerProvider = Provider((ref) => buildAppRouter(ref));
