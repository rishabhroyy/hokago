import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/router/app_router.dart';
import 'core/theme/app_theme.dart';

class HokagoApp extends ConsumerWidget {
  const HokagoApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(_routerProvider);
    return MaterialApp.router(
      title: 'hokago',
      debugShowCheckedModeBanner: false,
      theme: buildHokagoTheme(),
      routerConfig: router,
    );
  }
}

final _routerProvider = Provider((ref) => buildAppRouter(ref));
