import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../session/session_controller.dart';

/// Bridges sessionProvider changes into go_router's refreshListenable so a
/// login/logout/session-expiry immediately re-runs the redirect logic.
class SessionRefreshNotifier extends ChangeNotifier {
  SessionRefreshNotifier(Ref ref) {
    ref.listen(sessionProvider, (_, __) => notifyListeners());
  }
}
