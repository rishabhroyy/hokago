import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:media_kit/media_kit.dart';

import 'app.dart';
import 'core/theme/app_theme.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  MediaKit.ensureInitialized();
  // Edge-to-edge (Android 15+ enforces it anyway): the wallpaper and the
  // billboard art run under transparent system bars.
  SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
  SystemChrome.setSystemUIOverlayStyle(hokagoSystemOverlay);
  // No silent auto-retry: screens show their own "Try again" instead of
  // sitting on a spinner while Riverpod backs off in the background.
  runApp(ProviderScope(retry: (_, _) => null, child: const HokagoApp()));
}
