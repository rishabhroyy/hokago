import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/router/app_router.dart';
import 'core/theme/app_theme.dart';
import 'core/theme/hokago_background.dart';

class HokagoApp extends ConsumerWidget {
  const HokagoApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return MaterialApp.router(
      title: 'hokago',
      debugShowCheckedModeBanner: false,
      theme: buildHokagoTheme(),
      themeMode: ThemeMode.dark,
      // The wallpaper (app.css body::before + <Backdrop/>) painted once behind
      // every route, so every Scaffold can stay transparent over it.
      builder: (context, child) => HokagoBackground(child: child!),
      routerConfig: ref.watch(_routerProvider),
    );
  }
}

final _routerProvider = Provider((ref) => buildAppRouter(ref));
