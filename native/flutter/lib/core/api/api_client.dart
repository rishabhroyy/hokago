import 'dart:async';

import 'package:dio/dio.dart';

import 'token_store.dart';

/// Thrown when a request 401s and the refresh token itself is dead — the
/// session is over. Mirrors api-client.ts's sessionDead(): callers should
/// clear auth state and route to login.
class SessionExpiredException implements Exception {}

/// Dio wrapper mirroring apps/web/src/api-client.ts: bearer token attached
/// per-request, single-flight silent refresh when the access token is within
/// 60s of expiry or already 401'd, one retry, /auth/* requests never trigger
/// a refresh-retry loop (a bad password isn't a token problem).
class HokagoApiClient {
  HokagoApiClient({required String baseUrl}) : dio = Dio(BaseOptions(baseUrl: baseUrl, connectTimeout: const Duration(seconds: 15))) {
    dio.interceptors.add(InterceptorsWrapper(onRequest: _onRequest, onError: _onError));
  }

  final Dio dio;
  Completer<String?>? _refreshInFlight;

  /// Forces a refresh regardless of remaining TTL — mirrors native.ts's
  /// startTokenWarmth (4-min cadence) so a long idle screen (no API calls)
  /// never lets the access token go fully stale.
  Future<String?> warmToken() => _refreshAccessToken();

  Future<void> _onRequest(RequestOptions options, RequestInterceptorHandler handler) async {
    final token = await _ensureAccessToken();
    if (token != null) options.headers['Authorization'] = 'Bearer $token';
    handler.next(options);
  }

  Future<void> _onError(DioException err, ErrorInterceptorHandler handler) async {
    final response = err.response;
    final path = err.requestOptions.path;
    if (response?.statusCode != 401 || path.startsWith('/auth/')) {
      handler.next(err);
      return;
    }
    final fresh = await _refreshAccessToken();
    if (fresh == null) {
      handler.next(DioException(requestOptions: err.requestOptions, error: SessionExpiredException()));
      return;
    }
    try {
      final retryOptions = err.requestOptions;
      retryOptions.headers['Authorization'] = 'Bearer $fresh';
      final retried = await dio.fetch(retryOptions);
      handler.resolve(retried);
    } on DioException catch (e) {
      handler.next(e);
    }
  }

  Future<String?> _ensureAccessToken() async {
    final token = await TokenStore.instance.accessToken;
    if (token == null) return null;
    final remaining = TokenStore.expiresInMs(token);
    if (remaining == null || remaining > 60000) return token;
    return _refreshAccessToken();
  }

  Future<String?> _refreshAccessToken() async {
    if (_refreshInFlight != null) return _refreshInFlight!.future;
    final completer = Completer<String?>();
    _refreshInFlight = completer;
    try {
      final refreshToken = await TokenStore.instance.refreshToken;
      if (refreshToken == null) {
        completer.complete(null);
        return null;
      }
      final res = await Dio(BaseOptions(baseUrl: dio.options.baseUrl))
          .post('/auth/refresh', data: {'refreshToken': refreshToken});
      final accessToken = res.data['accessToken'] as String;
      await TokenStore.instance.setAccessToken(accessToken);
      completer.complete(accessToken);
      return accessToken;
    } catch (_) {
      completer.complete(null);
      return null;
    } finally {
      _refreshInFlight = null;
    }
  }
}
