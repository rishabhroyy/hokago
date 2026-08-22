/// Mirrors packages/contract/src/watch-party.ts.
class PartyMemberInfo {
  final String profileId;
  final String name;
  final String? avatarUrl;
  final String? sessionId;
  final bool ready;
  final int positionMs;
  PartyMemberInfo({required this.profileId, required this.name, required this.avatarUrl, required this.sessionId, required this.ready, required this.positionMs});
  factory PartyMemberInfo.fromJson(Map<String, dynamic> j) => PartyMemberInfo(
        profileId: j['profileId'] as String,
        name: j['name'] as String,
        avatarUrl: j['avatarUrl'] as String?,
        sessionId: j['sessionId'] as String?,
        ready: j['ready'] as bool? ?? false,
        positionMs: j['positionMs'] as int? ?? 0,
      );
}

class WatchPartyResponse {
  final String id;
  final String mediaItemId;
  final String mediaTitle;
  final String? mediaFileId;
  final String inviteCode;
  final String hostProfileId;
  final String state; // WAITING | PLAYING | PAUSED | ENDED
  final int positionMs;
  final String issuedAt;
  final List<PartyMemberInfo> members;

  WatchPartyResponse({
    required this.id,
    required this.mediaItemId,
    required this.mediaTitle,
    required this.mediaFileId,
    required this.inviteCode,
    required this.hostProfileId,
    required this.state,
    required this.positionMs,
    required this.issuedAt,
    required this.members,
  });

  factory WatchPartyResponse.fromJson(Map<String, dynamic> j) => WatchPartyResponse(
        id: j['id'] as String,
        mediaItemId: j['mediaItemId'] as String,
        mediaTitle: j['mediaTitle'] as String,
        mediaFileId: j['mediaFileId'] as String?,
        inviteCode: j['inviteCode'] as String,
        hostProfileId: j['hostProfileId'] as String,
        state: j['state'] as String,
        positionMs: j['positionMs'] as int,
        issuedAt: j['issuedAt'] as String,
        members: (j['members'] as List? ?? const []).map((e) => PartyMemberInfo.fromJson(e as Map<String, dynamic>)).toList(),
      );
}
