import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../session/session_controller.dart';
import 'active_downloads.dart';
import 'download_manager.dart';

final downloadManagerProvider = Provider<DownloadManager>((ref) {
  return DownloadManager(ref.read(sessionProvider.notifier).api, ref.read(activeDownloadsProvider.notifier));
});
