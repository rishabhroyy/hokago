import 'dart:io';

import 'package:flutter/services.dart';

/// The Android `tv` product flavor (`flutter build apk --flavor tv`). TV
/// builds get D-pad-first layout, pairing instead of password entry, and no
/// downloads (explicit product decision, docs/native-clients.md).
final bool isTvBuild = appFlavor == 'tv';

/// DevicePlatform enum values from packages/contract/src/auth.ts.
String currentDevicePlatform() {
  if (isTvBuild) return 'ANDROIDTV';
  if (Platform.isIOS) return 'IOS';
  if (Platform.isAndroid) return 'ANDROID';
  if (Platform.isMacOS) return 'MACOS';
  if (Platform.isWindows) return 'WINDOWS';
  if (Platform.isLinux) return 'LINUX';
  return 'ANDROID';
}

/// Shown in the server's device list (Settings → Devices).
String currentDeviceName() {
  if (isTvBuild) return 'hokago TV';
  if (Platform.isIOS) return 'hokago iPhone';
  if (Platform.isAndroid) return 'hokago Android';
  return 'hokago';
}
