import 'package:dio/dio.dart';

import 'api_client.dart';
import 'models/auth.dart';
import 'models/browse.dart';
import 'models/downloads.dart';
import 'models/home.dart';
import 'models/media_files.dart';
import 'models/party.dart';
import 'models/playback.dart';
import 'models/profile.dart';
import 'token_store.dart';

/// Typed surface over HokagoApiClient — one method per endpoint this app
/// uses, matching packages/contract/src/openapi.ts's registered paths
/// exactly (method, path, request/response shape).
class HokagoApi {
  HokagoApi(this._client);
  final HokagoApiClient _client;

  /// Forces a refresh regardless of remaining TTL — see HokagoApiClient.warmToken.
  Future<String?> warmToken() => _client.warmToken();

  String resolve(String path) {
    if (path.startsWith('http')) return path;
    final base = _client.dio.options.baseUrl.replaceAll(RegExp(r'/$'), '');
    return '$base$path';
  }

  // ── Setup ──────────────────────────────────────────────────────────────
  Future<SetupState> setupState() async {
    final res = await _client.dio.get('/setup/state');
    return SetupState.fromJson(res.data as Map<String, dynamic>);
  }

  Future<LoginResponse> completeSetup({required String username, required String password}) async {
    final res = await _client.dio.post('/setup/complete', data: {'username': username, 'password': password});
    return LoginResponse.fromJson(res.data as Map<String, dynamic>);
  }

  // ── Auth ───────────────────────────────────────────────────────────────
  Future<LoginResponse> login({required String username, required String password, required String platform}) async {
    final clientKey = await TokenStore.instance.clientKey;
    final res = await _client.dio.post('/auth/login', data: {
      'username': username,
      'password': password,
      'clientKey': clientKey,
      'deviceName': 'hokago mobile',
      'platform': platform,
    });
    return LoginResponse.fromJson(res.data as Map<String, dynamic>);
  }

  Future<void> logout(String refreshToken) async {
    await _client.dio.post('/auth/logout', data: {'refreshToken': refreshToken});
  }

  Future<PairingRequestResponse> pairRequest({required String name, required String platform}) async {
    final clientKey = await TokenStore.instance.clientKey;
    final res = await _client.dio.post('/auth/pair/request', data: {'name': name, 'platform': platform, 'clientKey': clientKey});
    return PairingRequestResponse.fromJson(res.data as Map<String, dynamic>);
  }

  Future<PairingStatusResponse> pairStatus(String pairingId) async {
    final res = await _client.dio.post('/auth/pair/status', data: {'pairingId': pairingId});
    return PairingStatusResponse.fromJson(res.data as Map<String, dynamic>);
  }

  // ── Profiles ───────────────────────────────────────────────────────────
  Future<List<Profile>> profiles() async {
    final res = await _client.dio.get('/profiles');
    return (res.data as List).map((e) => Profile.fromJson(e as Map<String, dynamic>)).toList();
  }

  // ── Browse ─────────────────────────────────────────────────────────────
  Future<List<LibrarySummary>> libraries() async {
    final res = await _client.dio.get('/libraries');
    return (res.data as List).map((e) => LibrarySummary.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<List<MediaCard>> libraryItems(String libraryId) async {
    final res = await _client.dio.get('/libraries/$libraryId/items');
    return (res.data as List).map((e) => MediaCard.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<MediaItemDetail> mediaItemDetail(String id, {String? profileId}) async {
    final res = await _client.dio.get('/media-items/$id', queryParameters: {if (profileId != null) 'profileId': profileId});
    return MediaItemDetail.fromJson(res.data as Map<String, dynamic>);
  }

  Future<List<MediaFileDescriptor>> mediaItemFiles(String id) async {
    final res = await _client.dio.get('/media-items/$id/files');
    return (res.data as List).map((e) => MediaFileDescriptor.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<HomeResponse> home({String? profileId}) async {
    final res = await _client.dio.get('/home', queryParameters: {if (profileId != null) 'profileId': profileId});
    return HomeResponse.fromJson(res.data as Map<String, dynamic>);
  }

  // ── Media file tracks ──────────────────────────────────────────────────
  Future<MediaFileTracksResponse> mediaFileTracks(String mediaFileId) async {
    final res = await _client.dio.get('/media-files/$mediaFileId/tracks');
    return MediaFileTracksResponse.fromJson(res.data as Map<String, dynamic>);
  }

  /// Subtitle text (VTT/SRT/ASS) for a track — fetched authenticated and fed
  /// to the player as in-memory SubtitleTrack.data, since media_kit's
  /// SubtitleTrack.uri has no per-request header support (the main Media()
  /// does, subtitles don't) and every hokago route requires a bearer token.
  Future<String> subtitleText(String mediaFileId, String trackId) async {
    final res = await _client.dio.get<String>(
      '/media-files/$mediaFileId/subtitle-tracks/$trackId',
      options: Options(responseType: ResponseType.plain),
    );
    return res.data ?? '';
  }

  Future<MediaFileTrickplayResponse?> mediaFileTrickplay(String mediaFileId) async {
    try {
      final res = await _client.dio.get('/media-files/$mediaFileId/trickplay');
      return MediaFileTrickplayResponse.fromJson(res.data as Map<String, dynamic>);
    } catch (_) {
      return null; // sheets not generated yet — same as the web client's silent catch
    }
  }

  // ── Playback ───────────────────────────────────────────────────────────
  Future<StartPlaybackResponse> startPlayback({
    required String profileId,
    required String mediaItemId,
    required String mediaFileId,
    int? audioStreamIndex,
  }) async {
    final res = await _client.dio.post('/playback/start', data: {
      'profileId': profileId,
      'mediaItemId': mediaItemId,
      'mediaFileId': mediaFileId,
      'deviceProfile': DeviceProfile.native.toJson(),
      if (audioStreamIndex != null) 'audioStreamIndex': audioStreamIndex,
    });
    return StartPlaybackResponse.fromJson(res.data as Map<String, dynamic>);
  }

  Future<SeekResponse> seek(String sessionId, int positionMs) async {
    final res = await _client.dio.post('/playback/$sessionId/seek', data: {'positionMs': positionMs});
    return SeekResponse.fromJson(res.data as Map<String, dynamic>);
  }

  Future<AudioTrackSwitchResponse> switchAudioTrack(String sessionId, int audioStreamIndex, int positionMs) async {
    final res = await _client.dio
        .post('/playback/$sessionId/audio-track', data: {'audioStreamIndex': audioStreamIndex, 'positionMs': positionMs});
    return AudioTrackSwitchResponse.fromJson(res.data as Map<String, dynamic>);
  }

  Future<QualitySwitchResponse> switchQuality(
    String sessionId, {
    required int positionMs,
    bool reset = false,
    int? maxWidth,
    int? maxHeight,
    int? maxVideoBitrateKbps,
  }) async {
    final res = await _client.dio.post('/playback/$sessionId/quality', data: {
      'positionMs': positionMs,
      if (reset) 'reset': true,
      if (maxWidth != null) 'maxWidth': maxWidth,
      if (maxHeight != null) 'maxHeight': maxHeight,
      if (maxVideoBitrateKbps != null) 'maxVideoBitrateKbps': maxVideoBitrateKbps,
    });
    return QualitySwitchResponse.fromJson(res.data as Map<String, dynamic>);
  }

  Future<void> heartbeat(String sessionId, {required int positionMs, int? durationMs}) async {
    await _client.dio
        .post('/playback/$sessionId/heartbeat', data: {'positionMs': positionMs, if (durationMs != null) 'durationMs': durationMs});
  }

  Future<void> stopPlayback(String sessionId) async {
    await _client.dio.post('/playback/$sessionId/stop');
  }

  // ── Downloads ──────────────────────────────────────────────────────────
  Future<List<DownloadInfo>> downloads({String? deviceId}) async {
    final res = await _client.dio.get('/downloads', queryParameters: {if (deviceId != null) 'deviceId': deviceId});
    return (res.data as List).map((e) => DownloadInfo.fromJson(e as Map<String, dynamic>)).toList();
  }

  /// [maxHeight]/[maxBitrateKbps] set: transcode variant (smaller file,
  /// server-side ffmpeg). Both null: original — the raw file, copied as-is.
  Future<DownloadInfo> createDownload({
    required String mediaItemId,
    required String mediaFileId,
    required String deviceId,
    List<String>? subtitleTrackIds,
    int? maxHeight,
    int? maxBitrateKbps,
  }) async {
    final res = await _client.dio.post('/downloads', data: {
      'mediaItemId': mediaItemId,
      'mediaFileId': mediaFileId,
      'deviceId': deviceId,
      'variant': maxHeight != null || maxBitrateKbps != null
          ? {'kind': 'transcode', if (maxHeight != null) 'maxHeight': maxHeight, if (maxBitrateKbps != null) 'maxBitrateKbps': maxBitrateKbps}
          : {'kind': 'original'},
      if (subtitleTrackIds != null) 'subtitleTrackIds': subtitleTrackIds,
    });
    return DownloadInfo.fromJson(res.data as Map<String, dynamic>);
  }

  Future<DownloadInfo> downloadStatus(String id) async {
    final res = await _client.dio.get('/downloads/$id');
    return DownloadInfo.fromJson(res.data as Map<String, dynamic>);
  }

  Future<void> deleteDownload(String id) async {
    await _client.dio.delete('/downloads/$id');
  }

  Future<DownloadArtifactManifest> downloadArtifact(String id) async {
    final res = await _client.dio.get('/downloads/$id/artifact');
    return DownloadArtifactManifest.fromJson(res.data as Map<String, dynamic>);
  }

  Future<int> syncWatchState({required String profileId, required List<Map<String, dynamic>> entries}) async {
    final res = await _client.dio.post('/watch-state/sync', data: {'profileId': profileId, 'entries': entries});
    return (res.data as Map<String, dynamic>)['synced'] as int? ?? 0;
  }

  Future<List<DeviceSummary>> devices() async {
    final res = await _client.dio.get('/auth/devices');
    return (res.data as List).map((e) => DeviceSummary.fromJson(e as Map<String, dynamic>)).toList();
  }

  /// Revokes every session bound to the device (may be this install).
  Future<void> deleteDevice(String id) async {
    await _client.dio.delete('/auth/devices/$id');
  }

  // ── Watch parties ──────────────────────────────────────────────────────
  Future<WatchPartyResponse> createParty({required String profileId, required String mediaItemId}) async {
    final res = await _client.dio.post('/parties', data: {'profileId': profileId, 'mediaItemId': mediaItemId});
    return WatchPartyResponse.fromJson(res.data as Map<String, dynamic>);
  }

  Future<WatchPartyResponse> joinParty({required String inviteCode, required String profileId}) async {
    final res = await _client.dio.post('/parties/join', data: {'inviteCode': inviteCode, 'profileId': profileId});
    return WatchPartyResponse.fromJson(res.data as Map<String, dynamic>);
  }

  Future<void> leaveParty(String partyId) async {
    await _client.dio.post('/parties/$partyId/leave');
  }

  Future<void> setPartyReady(String partyId, bool ready) async {
    await _client.dio.post('/parties/$partyId/ready', data: {'ready': ready});
  }

  Future<void> linkPartySession(String partyId, String sessionId) async {
    await _client.dio.post('/parties/$partyId/session', data: {'sessionId': sessionId});
  }

  Future<WatchPartyResponse?> controlParty(String partyId, {required String state, required int positionMs}) async {
    final res = await _client.dio.post('/parties/$partyId/control', data: {'state': state, 'positionMs': positionMs});
    return res.data != null ? WatchPartyResponse.fromJson(res.data as Map<String, dynamic>) : null;
  }

  /// wss://host/ws/party/{partyId}?token=... — browsers can't set WS
  /// handshake headers, so the access JWT rides as a query param, same as
  /// the web's connectPartySocket.
  Future<String> partySocketUrl(String partyId) async {
    final token = await warmToken() ?? await TokenStore.instance.accessToken;
    final base = _client.dio.options.baseUrl.replaceFirst(RegExp(r'^http'), 'ws');
    return '$base/ws/party/${Uri.encodeComponent(partyId)}?token=${Uri.encodeComponent(token ?? '')}';
  }
}
