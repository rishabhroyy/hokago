import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';

import '../api/hokago_api.dart';
import '../api/models/party.dart';

class PartyCommand {
  final String state; // WAITING | PLAYING | PAUSED
  final int positionMs;
  final String issuedAt;
  const PartyCommand({required this.state, required this.positionMs, required this.issuedAt});
}

/// The client half of the timekeeper contract — mirrors useParty.ts /
/// party-api.ts's connectPartySocket exactly: one WS connection per party,
/// every frame is a full snapshot, reconnect with capped exponential
/// backoff, and the host's own control POSTs are suppressed as echoes by
/// matching issuedAt (the server stamps and rebroadcasts every command,
/// including back to its sender).
class PartyController {
  PartyController(this._api, {required this.partyId, required this.profileId}) {
    _connect();
  }

  final HokagoApi _api;
  final String partyId;
  final String profileId;

  final _partyStream = StreamController<WatchPartyResponse>.broadcast();
  final _commandStream = StreamController<PartyCommand>.broadcast();
  Stream<WatchPartyResponse> get partyUpdates => _partyStream.stream;
  Stream<PartyCommand> get commands => _commandStream.stream;

  WatchPartyResponse? party;
  bool connected = false;
  String? _lastSentIssuedAt;
  WebSocketChannel? _socket;
  Timer? _retryTimer;
  int _retry = 0;
  bool _closed = false;

  bool get isHost => party?.hostProfileId == profileId;
  bool get locked => party != null && !isHost && party!.state != 'ENDED';

  Future<void> _connect() async {
    if (_closed) return;
    try {
      final url = await _api.partySocketUrl(partyId);
      if (_closed) return;
      final socket = WebSocketChannel.connect(Uri.parse(url));
      _socket = socket;
      await socket.ready;
      _retry = 0;
      connected = true;
      socket.stream.listen(
        _onMessage,
        onDone: _scheduleReconnect,
        onError: (_) => _scheduleReconnect(),
        cancelOnError: true,
      );
    } catch (_) {
      _scheduleReconnect();
    }
  }

  void _onMessage(dynamic raw) {
    try {
      final msg = jsonDecode(raw as String) as Map<String, dynamic>;
      if (msg['type'] != 'party' || msg['party'] == null) return;
      final incoming = WatchPartyResponse.fromJson(msg['party'] as Map<String, dynamic>);
      final echo = isHost && incoming.issuedAt == _lastSentIssuedAt;
      party = incoming;
      connected = true;
      _partyStream.add(incoming);
      if (!echo && incoming.state != 'ENDED') {
        _commandStream.add(PartyCommand(state: incoming.state, positionMs: incoming.positionMs, issuedAt: incoming.issuedAt));
      }
    } catch (_) {
      // malformed frame — ignore, next snapshot will re-sync
    }
  }

  void _scheduleReconnect() {
    if (_closed) return;
    connected = false;
    _retry = (_retry + 1).clamp(0, 6);
    _retryTimer?.cancel();
    _retryTimer = Timer(Duration(milliseconds: 250 * (1 << _retry)), _connect);
  }

  Future<void> control(String state, int positionMs) async {
    final updated = await _api.controlParty(partyId, state: state, positionMs: positionMs);
    if (updated != null) _lastSentIssuedAt = updated.issuedAt;
  }

  Future<void> setReady(bool ready) => _api.setPartyReady(partyId, ready);

  Future<void> linkSession(String sessionId) => _api.linkPartySession(partyId, sessionId);

  Future<void> leave() => _api.leaveParty(partyId).catchError((_) {});

  void dispose() {
    _closed = true;
    _retryTimer?.cancel();
    _socket?.sink.close();
    _partyStream.close();
    _commandStream.close();
  }
}
