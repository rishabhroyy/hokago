import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:uuid/uuid.dart';

/// Secure-store mirror of the web's localStorage session keys
/// (apps/web/src/api-client.ts) — Keychain on iOS, Keystore-backed on
/// Android. One account per install for v1 (no TV multi-account switcher yet
/// — see docs/native-clients.md's TvAccountsView for the web equivalent).
class TokenStore {
  TokenStore._();
  static final instance = TokenStore._();

  final _storage = const FlutterSecureStorage();

  static const _accessKey = 'hokago_access_token';
  static const _refreshKey = 'hokago_refresh_token';
  static const _deviceIdKey = 'hokago_device_id';
  static const _serverUrlKey = 'hokago_server_url';
  static const _clientKeyKey = 'hokago_client_key';
  static const _profileKey = 'hokago_profile';

  Future<String?> get accessToken => _storage.read(key: _accessKey);
  Future<void> setAccessToken(String v) => _storage.write(key: _accessKey, value: v);

  Future<String?> get refreshToken => _storage.read(key: _refreshKey);
  Future<void> setRefreshToken(String v) => _storage.write(key: _refreshKey, value: v);

  Future<String?> get deviceId => _storage.read(key: _deviceIdKey);
  Future<void> setDeviceId(String? v) =>
      v == null ? _storage.delete(key: _deviceIdKey) : _storage.write(key: _deviceIdKey, value: v);

  Future<String?> get serverUrl => _storage.read(key: _serverUrlKey);
  Future<void> setServerUrl(String v) => _storage.write(key: _serverUrlKey, value: v);

  /// Last selected profile as "id\nname" — lets a cold start with no server
  /// reachable still open (offline downloads + the offline watch queue).
  Future<(String, String)?> get lastProfile async {
    final v = await _storage.read(key: _profileKey);
    final i = v?.indexOf('\n') ?? -1;
    return i > 0 ? (v!.substring(0, i), v.substring(i + 1)) : null;
  }

  Future<void> setLastProfile(String id, String name) => _storage.write(key: _profileKey, value: '$id\n$name');

  Future<String> get clientKey async {
    final existing = await _storage.read(key: _clientKeyKey);
    if (existing != null) return existing;
    // Stable per-install identity (LoginBody.clientKey) — generated once,
    // never regenerated, survives app updates (Keychain/Keystore-backed).
    final fresh = const Uuid().v4();
    await _storage.write(key: _clientKeyKey, value: fresh);
    return fresh;
  }

  Future<void> clearSession() async {
    await _storage.delete(key: _accessKey);
    await _storage.delete(key: _refreshKey);
    await _storage.delete(key: _deviceIdKey);
    await _storage.delete(key: _profileKey);
  }

  /// Decodes the JWT payload without verifying — mirrors api-client.ts's
  /// tokenExpiresInMs, only used to decide whether a silent refresh is due.
  static int? expiresInMs(String token) {
    try {
      final parts = token.split('.');
      if (parts.length != 3) return null;
      var payload = parts[1].replaceAll('-', '+').replaceAll('_', '/');
      payload += '=' * ((4 - payload.length % 4) % 4);
      final json = jsonDecode(utf8.decode(base64.decode(payload))) as Map<String, dynamic>;
      final exp = json['exp'];
      if (exp is! num) return null;
      return (exp * 1000).round() - DateTime.now().millisecondsSinceEpoch;
    } catch (_) {
      return null;
    }
  }
}
