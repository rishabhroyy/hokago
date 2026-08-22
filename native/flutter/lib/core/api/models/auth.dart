/// Mirrors packages/contract/src/auth.ts.
class LoginResponse {
  final String accessToken;
  final String refreshToken;
  final String sessionId;
  final String? deviceId;
  LoginResponse({required this.accessToken, required this.refreshToken, required this.sessionId, required this.deviceId});
  factory LoginResponse.fromJson(Map<String, dynamic> j) => LoginResponse(
        accessToken: j['accessToken'] as String,
        refreshToken: j['refreshToken'] as String,
        sessionId: j['sessionId'] as String,
        deviceId: j['deviceId'] as String?,
      );
}

class DeviceSummary {
  final String id;
  final String name;
  final String platform;
  final DateTime createdAt;
  final DateTime? lastSeenAt;
  DeviceSummary({required this.id, required this.name, required this.platform, required this.createdAt, required this.lastSeenAt});
  factory DeviceSummary.fromJson(Map<String, dynamic> j) => DeviceSummary(
        id: j['id'] as String,
        name: j['name'] as String,
        platform: j['platform'] as String,
        createdAt: DateTime.parse(j['createdAt'] as String),
        lastSeenAt: j['lastSeenAt'] != null ? DateTime.tryParse(j['lastSeenAt'] as String) : null,
      );
}

class PairingRequestResponse {
  final String pairingId;
  final String code;
  final DateTime expiresAt;
  PairingRequestResponse({required this.pairingId, required this.code, required this.expiresAt});
  factory PairingRequestResponse.fromJson(Map<String, dynamic> j) => PairingRequestResponse(
        pairingId: j['pairingId'] as String,
        code: j['code'] as String,
        expiresAt: DateTime.parse(j['expiresAt'] as String),
      );
}

class PairingStatusResponse {
  final String status; // PENDING | APPROVED | COMPLETE | EXPIRED
  final String? accessToken;
  final String? refreshToken;
  final String? sessionId;
  final String? deviceId;
  final String? username;
  PairingStatusResponse({
    required this.status,
    required this.accessToken,
    required this.refreshToken,
    required this.sessionId,
    required this.deviceId,
    required this.username,
  });
  factory PairingStatusResponse.fromJson(Map<String, dynamic> j) => PairingStatusResponse(
        status: j['status'] as String,
        accessToken: j['accessToken'] as String?,
        refreshToken: j['refreshToken'] as String?,
        sessionId: j['sessionId'] as String?,
        deviceId: j['deviceId'] as String?,
        username: j['username'] as String?,
      );
}

class SetupState {
  final bool setupRequired;
  SetupState({required this.setupRequired});
  factory SetupState.fromJson(Map<String, dynamic> j) => SetupState(setupRequired: j['setupRequired'] as bool);
}
