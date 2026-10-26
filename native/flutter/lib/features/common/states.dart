import 'package:flutter/material.dart';

import '../../core/theme/app_theme.dart';
import '../../core/widgets/hokago_icon.dart';
import '../../core/widgets/hokago_panel.dart';
import '../../core/widgets/wii_button.dart';

/// The one empty / error state: a glossy blue channel badge, a display-face
/// line, a quiet explanation and an optional action — never a provider
/// name, status code or stack trace ("degrade, never error").
class MessageState extends StatelessWidget {
  const MessageState({super.key, required this.icon, required this.title, required this.message, this.actionLabel, this.onAction});
  final String icon;
  final String title;
  final String message;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 440),
          child: HokagoPanel(
            borderRadius: 32,
            padding: const EdgeInsets.fromLTRB(28, 36, 28, 32),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  width: 80,
                  height: 80,
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(26),
                    gradient: const LinearGradient(begin: Alignment.topLeft, end: Alignment.bottomRight, colors: [HokagoColors.wiiBtnTop, HokagoColors.wiiBtnBottom]),
                    boxShadow: const [BoxShadow(color: Color(0xA62E9BC4), blurRadius: 18, spreadRadius: -6, offset: Offset(0, 6))],
                  ),
                  alignment: Alignment.center,
                  child: icon == 'logo' ? const HokagoLogoMark(size: 44) : HokagoIcon(icon, size: 34, color: Colors.white),
                ),
                const SizedBox(height: 22),
                Text(title, style: HokagoText.title.copyWith(fontSize: 24), textAlign: TextAlign.center),
                const SizedBox(height: 8),
                Text(message, style: HokagoText.body, textAlign: TextAlign.center),
                if (actionLabel != null && onAction != null) ...[
                  const SizedBox(height: 24),
                  WiiButton(label: actionLabel!, onPressed: onAction, autofocus: true),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// A large page heading — app.css's `.page-title` + optional `.count`.
class PageHeader extends StatelessWidget {
  const PageHeader(this.title, {super.key, this.count, this.sub, this.trailing});
  final String title;
  final int? count;
  final String? sub;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text.rich(
                TextSpan(children: [
                  TextSpan(text: title),
                  if (count != null)
                    TextSpan(
                      text: '  $count',
                      style: HokagoText.meta.copyWith(color: HokagoColors.ink3, fontFeatures: const [FontFeature.tabularFigures()]),
                    ),
                ]),
                style: HokagoText.title,
              ),
              if (sub != null) ...[const SizedBox(height: 4), Text(sub!, style: HokagoText.body)],
            ],
          ),
        ),
        ?trailing,
      ],
    );
  }
}
