import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../session/session_controller.dart';
import 'download_manager.dart';

final downloadManagerProvider = Provider<DownloadManager>((ref) {
  final manager = DownloadManager(ref.read(sessionProvider.notifier).api);
  ref.onDispose(manager.dispose);
  return manager;
});
