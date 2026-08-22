import 'dart:convert';
import 'dart:io';

import 'package:path_provider/path_provider.dart';

/// Local record of a saved download — mirrors apps/web/src/offline.ts's
/// OfflineEntry, persisted as a flat JSON file instead of localStorage.
class OfflineEntry {
  final String downloadId;
  final String mediaItemId;
  final String mediaFileId;
  final String title;
  final String kind; // MOVIE | SERIES(unused) | EPISODE
  final String? subtitle;
  final String? posterUrl;
  final int? durationMs;
  final String localPath;
  final int sizeBytes;

  OfflineEntry({
    required this.downloadId,
    required this.mediaItemId,
    required this.mediaFileId,
    required this.title,
    required this.kind,
    required this.subtitle,
    required this.posterUrl,
    required this.durationMs,
    required this.localPath,
    required this.sizeBytes,
  });

  Map<String, dynamic> toJson() => {
        'downloadId': downloadId,
        'mediaItemId': mediaItemId,
        'mediaFileId': mediaFileId,
        'title': title,
        'kind': kind,
        'subtitle': subtitle,
        'posterUrl': posterUrl,
        'durationMs': durationMs,
        'localPath': localPath,
        'sizeBytes': sizeBytes,
      };

  factory OfflineEntry.fromJson(Map<String, dynamic> j) => OfflineEntry(
        downloadId: j['downloadId'] as String,
        mediaItemId: j['mediaItemId'] as String,
        mediaFileId: j['mediaFileId'] as String,
        title: j['title'] as String,
        kind: j['kind'] as String,
        subtitle: j['subtitle'] as String?,
        posterUrl: j['posterUrl'] as String?,
        durationMs: j['durationMs'] as int?,
        localPath: j['localPath'] as String,
        sizeBytes: j['sizeBytes'] as int? ?? 0,
      );
}

/// Flat-file manifest of everything saved on this device — the offline
/// library's index. Ground truth for *bytes on disk* is the filesystem
/// itself; reconcile() drops entries whose file has vanished.
class OfflineManifest {
  OfflineManifest._();
  static final instance = OfflineManifest._();

  Future<File> _file() async {
    final dir = await getApplicationDocumentsDirectory();
    return File('${dir.path}/hokago_offline_manifest.json');
  }

  Future<Map<String, OfflineEntry>> _read() async {
    final f = await _file();
    if (!await f.exists()) return {};
    try {
      final raw = jsonDecode(await f.readAsString()) as Map<String, dynamic>;
      return raw.map((k, v) => MapEntry(k, OfflineEntry.fromJson(v as Map<String, dynamic>)));
    } catch (_) {
      return {};
    }
  }

  Future<void> _write(Map<String, OfflineEntry> map) async {
    final f = await _file();
    await f.writeAsString(jsonEncode(map.map((k, v) => MapEntry(k, v.toJson()))));
  }

  Future<List<OfflineEntry>> all() async {
    final map = await _read();
    final list = map.values.toList()..sort((a, b) => a.title.compareTo(b.title));
    return list;
  }

  Future<void> record(OfflineEntry entry) async {
    final map = await _read();
    map[entry.downloadId] = entry;
    await _write(map);
  }

  Future<void> remove(String downloadId) async {
    final map = await _read();
    final entry = map.remove(downloadId);
    await _write(map);
    if (entry != null) {
      final f = File(entry.localPath);
      if (await f.exists()) await f.delete();
    }
  }

  /// Drops entries whose backing file no longer exists (reinstall, manual
  /// deletion) — mirrors offline.ts's reconcileOfflineManifest.
  Future<List<OfflineEntry>> reconcile() async {
    final map = await _read();
    var changed = false;
    for (final id in map.keys.toList()) {
      if (!await File(map[id]!.localPath).exists()) {
        map.remove(id);
        changed = true;
      }
    }
    if (changed) await _write(map);
    return map.values.toList()..sort((a, b) => a.title.compareTo(b.title));
  }
}
