import 'package:flutter/services.dart';

import '../../core/platform.dart';

/// Full-screen video: hide the system bars (a swipe brings them back) and,
/// on phones, rotate to landscape. Restored on exit. TVs are always landscape.
void enterPlayerMode() {
  SystemChrome.setEnabledSystemUIMode(SystemUiMode.immersiveSticky);
  if (!isTvBuild) SystemChrome.setPreferredOrientations([DeviceOrientation.landscapeLeft, DeviceOrientation.landscapeRight]);
}

void exitPlayerMode() {
  SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge);
  if (!isTvBuild) SystemChrome.setPreferredOrientations(const []);
}
