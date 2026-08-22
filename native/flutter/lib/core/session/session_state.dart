enum SessionStatus { loading, needsServer, needsSetup, needsLogin, authenticated }

class SessionState {
  final SessionStatus status;
  final String? serverUrl;
  final String? profileId;
  final String? profileName;
  final String? error;
  final String? accessToken;

  const SessionState({required this.status, this.serverUrl, this.profileId, this.profileName, this.error, this.accessToken});

  const SessionState.loading() : this(status: SessionStatus.loading);

  SessionState copyWith({
    SessionStatus? status,
    String? serverUrl,
    String? profileId,
    String? profileName,
    String? error,
    String? accessToken,
  }) =>
      SessionState(
        status: status ?? this.status,
        serverUrl: serverUrl ?? this.serverUrl,
        profileId: profileId ?? this.profileId,
        profileName: profileName ?? this.profileName,
        error: error,
        accessToken: accessToken ?? this.accessToken,
      );
}
