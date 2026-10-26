import 'package:flutter/material.dart';

import '../../core/theme/app_theme.dart';
import '../../core/widgets/hokago_icon.dart';
import '../../core/widgets/hokago_panel.dart';

/// LoginView.tsx's card: the floating frosted `.panel` with the hokago mark,
/// a display-face title and a quiet line under it. Every gate screen
/// (server, setup, login, pair, profiles) is one of these.
class GateCard extends StatelessWidget {
  const GateCard({super.key, required this.title, this.subtitle, required this.children, this.maxWidth = 420, this.showMark = true});
  final String title;
  final String? subtitle;
  final List<Widget> children;
  final double maxWidth;
  final bool showMark;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(20),
            keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
            child: ConstrainedBox(
              constraints: BoxConstraints(maxWidth: maxWidth),
              child: HokagoPanel(
                borderRadius: 32,
                padding: const EdgeInsets.fromLTRB(28, 32, 28, 28),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (showMark) ...[
                      const Center(child: HokagoLogoMark(size: 52)),
                      const SizedBox(height: 18),
                    ],
                    Text(title, style: HokagoText.title, textAlign: TextAlign.center),
                    if (subtitle != null) ...[
                      const SizedBox(height: 6),
                      Text(subtitle!, style: HokagoText.body, textAlign: TextAlign.center),
                    ],
                    const SizedBox(height: 24),
                    ...children,
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class GateError extends StatelessWidget {
  const GateError(this.message, {super.key});
  final String? message;
  @override
  Widget build(BuildContext context) => AnimatedSize(
        duration: const Duration(milliseconds: 200),
        child: message == null
            ? const SizedBox(width: double.infinity)
            : Padding(
                padding: const EdgeInsets.only(top: 12),
                child: Text(message!, textAlign: TextAlign.center, style: HokagoText.meta.copyWith(color: HokagoColors.accent, fontWeight: FontWeight.w600)),
              ),
      );
}
