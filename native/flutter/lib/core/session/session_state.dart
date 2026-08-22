enum SessionStatus { loading, needsServer, needsSetup, needsLogin, needsProfile, authenticated }

class ProfileOption {
  final String id;
  final String name;
  const ProfileOption({required this.id, required this.name});
}

class SessionState {
  final SessionStatus status;
  final String? serverUrl;
  final String? profileId;
  final String? profileName;
  final String? error;
  final String? accessToken;
  /// Every profile on the account — populated once, used by needsProfile
  /// (picker) and Prefs' "switch profile". Web equivalent: profile.ts.
  final List<ProfileOption> profiles;

  const SessionState({
    required this.status,
    this.serverUrl,
    this.profileId,
    this.profileName,
    this.error,
    this.accessToken,
    this.profiles = const [],
  });

  const SessionState.loading() : this(status: SessionStatus.loading);

  SessionState copyWith({
    SessionStatus? status,
    String? serverUrl,
    String? profileId,
    String? profileName,
    String? error,
    String? accessToken,
    List<ProfileOption>? profiles,
  }) =>
      SessionState(
        status: status ?? this.status,
        serverUrl: serverUrl ?? this.serverUrl,
        profileId: profileId ?? this.profileId,
        profileName: profileName ?? this.profileName,
        error: error,
        accessToken: accessToken ?? this.accessToken,
        profiles: profiles ?? this.profiles,
      );

  /// Explicit null-out for profileId (copyWith's `?? this.x` can't express
  /// "clear this field" — needed by "switch profile").
  SessionState clearProfile() => SessionState(
        status: SessionStatus.needsProfile,
        serverUrl: serverUrl,
        error: error,
        accessToken: accessToken,
        profiles: profiles,
      );
}
