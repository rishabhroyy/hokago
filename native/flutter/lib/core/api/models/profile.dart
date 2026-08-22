/// Mirrors packages/contract/src/profiles.ts.
class Profile {
  final String id;
  final String accountId;
  final String name;
  final String? avatarPath;

  Profile({required this.id, required this.accountId, required this.name, required this.avatarPath});

  factory Profile.fromJson(Map<String, dynamic> j) =>
      Profile(id: j['id'] as String, accountId: j['accountId'] as String, name: j['name'] as String, avatarPath: j['avatarPath'] as String?);
}
