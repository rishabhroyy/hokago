import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'app_theme.dart';

const _key = 'hokago_dark_mode';

/// Persisted light/dark toggle — mirrors the web's useTheme.tsx (a
/// localStorage-remembered `.dark` class flip). Owns HokagoColors.setDark
/// so every widget reading the static getters picks up the new palette the
/// next time it rebuilds (which happens because this provider changing
/// forces HokagoApp to rebuild MaterialApp.router with a fresh theme).
class ThemeModeController extends StateNotifier<bool> {
  ThemeModeController() : super(false) {
    _restore();
  }

  final _storage = const FlutterSecureStorage();

  Future<void> _restore() async {
    final stored = await _storage.read(key: _key);
    final dark = stored == '1';
    HokagoColors.setDark(dark);
    state = dark;
  }

  Future<void> setDark(bool dark) async {
    HokagoColors.setDark(dark);
    state = dark;
    await _storage.write(key: _key, value: dark ? '1' : '0');
  }
}

final themeModeProvider = StateNotifierProvider<ThemeModeController, bool>((ref) => ThemeModeController());
