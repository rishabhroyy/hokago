import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';

import '../api/hokago_api.dart';

/// Watch progress from offline playback, queued on disk and flushed to
/// `/watch-state/sync` once the server answers again — offline.ts's
/// queueWatchState/flushWatchSync. One entry per item (latest wins), keyed
/// by profile so a shared device never syncs one profile's progress to another.
class OfflineWatchQueue {
  OfflineWatchQueue._();
  static final instance = OfflineWatchQueue._();

  Future<File> _file() async => File('${(await getApplicationDocumentsDirectory()).path}/hokago_watch_queue.json');

  Future<Map<String, dynamic>> _read() async {
    final f = await _file();
    if (!await f.exists()) return {};
    try {
      return jsonDecode(await f.readAsString()) as Map<String, dynamic>;
    } catch (_) {
      return {};
    }
  }

  Future<void> record({required String profileId, required String mediaItemId, required int positionMs, int? durationMs}) async {
    final all = await _read();
    final forProfile = (all[profileId] as Map<String, dynamic>?) ?? {};
    // ≥90% in counts as finished, same threshold idea as the server's own completion.
    final watched = durationMs != null && durationMs > 0 && positionMs >= durationMs * 0.9;
    forProfile[mediaItemId] = {
      'mediaItemId': mediaItemId,
      'positionMs': positionMs,
      'durationMs': ?(durationMs != null && durationMs > 0 ? durationMs : null),
      'watched': watched,
      'lastWatchedAt': DateTime.now().toUtc().toIso8601String(),
    };
    all[profileId] = forProfile;
    await (await _file()).writeAsString(jsonEncode(all));
  }

  /// The queued (not yet synced) position — the offline player's resume point.
  Future<int?> positionFor(String profileId, String mediaItemId) async {
    final entry = ((await _read())[profileId] as Map<String, dynamic>?)?[mediaItemId] as Map<String, dynamic>?;
    if (entry == null || entry['watched'] == true) return null;
    return entry['positionMs'] as int?;
  }

  /// Best-effort; leaves the queue intact on any failure so the next flush retries.
  Future<void> flush(HokagoApi api, String profileId) async {
    final all = await _read();
    final forProfile = (all[profileId] as Map<String, dynamic>?) ?? {};
    if (forProfile.isEmpty) return;
    try {
      await api.syncWatchState(profileId: profileId, entries: forProfile.values.cast<Map<String, dynamic>>().toList());
      // Re-read: playback may have queued more while the request was in flight.
      final latest = await _read();
      final mine = (latest[profileId] as Map<String, dynamic>?) ?? {};
      for (final k in forProfile.keys) {
        if (jsonEncode(mine[k]) == jsonEncode(forProfile[k])) mine.remove(k);
      }
      latest[profileId] = mine;
      await (await _file()).writeAsString(jsonEncode(latest));
    } catch (_) {
      // still offline / server down — keep the queue
    }
  }
}
