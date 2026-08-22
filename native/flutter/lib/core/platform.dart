import 'dart:io';

/// DevicePlatform enum values from packages/contract/src/auth.ts. TV variants
/// (ANDROIDTV/GOOGLETV) are set by the Android TV flavor build, not detected
/// at runtime here.
String currentDevicePlatform() {
  if (Platform.isIOS) return 'IOS';
  if (Platform.isAndroid) return 'ANDROID';
  if (Platform.isMacOS) return 'MACOS';
  if (Platform.isWindows) return 'WINDOWS';
  if (Platform.isLinux) return 'LINUX';
  return 'ANDROID';
}
