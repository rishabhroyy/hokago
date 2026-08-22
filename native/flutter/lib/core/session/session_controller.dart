import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/api_client.dart';
import '../api/hokago_api.dart';
import '../api/token_store.dart';
import '../platform.dart';
import 'session_state.dart';

const _tokenWarmthInterval = Duration(minutes: 4);

/// Owns the boot sequence (server URL → setup check → auth check → primary
/// profile) and the current HokagoApi instance. Mirrors the web app's
/// api-client.ts + browse-api.ts + profile.ts boot flow, condensed into one
/// controller since there's no router-driven redirect chain to replicate.
class SessionController extends StateNotifier<SessionState> {
  SessionController() : super(const SessionState.loading()) {
    _init();
  }

  HokagoApi? _api;
  HokagoApi get api {
    final a = _api;
    if (a == null) throw StateError('SessionController.api read before a server URL was set');
    return a;
  }

  Timer? _warmthTimer;

  void _startTokenWarmth() {
    _warmthTimer?.cancel();
    _warmthTimer = Timer.periodic(_tokenWarmthInterval, (_) async {
      final fresh = await _api?.warmToken();
      if (fresh != null) state = state.copyWith(accessToken: fresh);
    });
  }

  @override
  void dispose() {
    _warmthTimer?.cancel();
    super.dispose();
  }

  Future<void> _init() async {
    final storedUrl = await TokenStore.instance.serverUrl;
    if (storedUrl == null) {
      state = state.copyWith(status: SessionStatus.needsServer);
      return;
    }
    await _connectTo(storedUrl, persist: false);
  }

  Future<void> setServerUrl(String rawUrl) async {
    final url = _normalize(rawUrl);
    await TokenStore.instance.setServerUrl(url);
    await _connectTo(url, persist: false);
  }

  String _normalize(String url) {
    var u = url.trim();
    if (!u.startsWith('http://') && !u.startsWith('https://')) u = 'https://$u';
    return u.replaceAll(RegExp(r'/$'), '');
  }

  Future<void> _connectTo(String url, {required bool persist}) async {
    state = state.copyWith(status: SessionStatus.loading, serverUrl: url);
    _api = HokagoApi(HokagoApiClient(baseUrl: url));
    try {
      final setup = await api.setupState();
      if (setup.setupRequired) {
        state = state.copyWith(status: SessionStatus.needsSetup);
        return;
      }
      final access = await TokenStore.instance.accessToken;
      final refresh = await TokenStore.instance.refreshToken;
      if (access == null || refresh == null) {
        state = state.copyWith(status: SessionStatus.needsLogin);
        return;
      }
      await _resolvePrimaryProfile();
    } catch (e) {
      state = state.copyWith(status: SessionStatus.needsServer, error: 'Could not reach that server: $e');
    }
  }

  Future<void> completeSetup({required String username, required String password}) async {
    final res = await api.completeSetup(username: username, password: password);
    await TokenStore.instance.setAccessToken(res.accessToken);
    await TokenStore.instance.setRefreshToken(res.refreshToken);
    await _resolvePrimaryProfile();
  }

  Future<void> login({required String username, required String password}) async {
    state = state.copyWith(status: SessionStatus.loading);
    try {
      final res = await api.login(username: username, password: password, platform: currentDevicePlatform());
      await TokenStore.instance.setAccessToken(res.accessToken);
      await TokenStore.instance.setRefreshToken(res.refreshToken);
      await TokenStore.instance.setDeviceId(res.deviceId);
      await _resolvePrimaryProfile();
    } catch (e) {
      state = state.copyWith(status: SessionStatus.needsLogin, error: 'Login failed — check your username and password.');
    }
  }

  /// One profile: auto-select it (matches the web's getPrimaryProfile — no
  /// picker needed when there's nothing to pick). Multiple: land on the
  /// picker (needsProfile), same as the web's account-switcher intent, just
  /// surfaced once up front instead of a persistent switcher affordance.
  Future<void> _resolvePrimaryProfile() async {
    final token = await TokenStore.instance.accessToken;
    try {
      final profiles = await api.profiles();
      final options = profiles.map((p) => ProfileOption(id: p.id, name: p.name)).toList();
      if (options.length <= 1) {
        final only = options.isNotEmpty ? options.first : null;
        state = state.copyWith(
          status: SessionStatus.authenticated,
          profileId: only?.id,
          profileName: only?.name,
          accessToken: token,
          profiles: options,
        );
      } else {
        state = state.copyWith(status: SessionStatus.needsProfile, accessToken: token, profiles: options);
      }
    } catch (_) {
      state = state.copyWith(status: SessionStatus.authenticated, accessToken: token);
    }
    _startTokenWarmth();
  }

  void selectProfile(ProfileOption profile) {
    state = state.copyWith(status: SessionStatus.authenticated, profileId: profile.id, profileName: profile.name);
  }

  /// Prefs' "switch profile" — drops the active selection and returns to
  /// the picker without a full re-login.
  void switchProfile() {
    if (state.profiles.length > 1) state = state.clearProfile();
  }

  Future<void> logout() async {
    final refresh = await TokenStore.instance.refreshToken;
    if (refresh != null) {
      try {
        await api.logout(refresh);
      } catch (_) {
        // best-effort — clear locally regardless
      }
    }
    await TokenStore.instance.clearSession();
    _warmthTimer?.cancel();
    // A fresh SessionState, not copyWith — copyWith's `x ?? this.x` pattern
    // can't express "clear this field", so passing profileId/profileName as
    // null there would silently keep the old values.
    state = SessionState(status: SessionStatus.needsLogin, serverUrl: state.serverUrl);
  }

  /// "Change server" — back to the setup screen, keeping no session state.
  Future<void> changeServer() async {
    await TokenStore.instance.clearSession();
    _warmthTimer?.cancel();
    state = const SessionState(status: SessionStatus.needsServer);
  }
}

final sessionProvider = StateNotifierProvider<SessionController, SessionState>((ref) => SessionController());
