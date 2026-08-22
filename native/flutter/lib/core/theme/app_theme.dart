import 'package:flutter/material.dart';

/// hokago design tokens, ported directly from apps/web/src/app.css's `:root`
/// (light — the web's actual default theme, not `.dark`) + component classes
/// (.btn-primary, .panel, .input). Rishabh's call: light is "cute like Wii,"
/// dark read as muted/moody on mobile — matches the web's own default
/// (`.dark` is an opt-in toggle there, not the primary look).
abstract final class HokagoColors {
  static const bg = Color(0xFFF5EFE4);
  static const paper = Color(0xFFF6F0E6);
  static const paper2 = Color(0xFFEFE7D8);
  static const card = Color(0xFFFFFFFF);
  static const ink = Color(0xFF35302B);
  static const ink2 = Color(0xFF72695F);
  static const ink3 = Color(0xFF8B8177);
  static const line = Color(0xFFE6DDCE);
  static const line2 = Color(0xFFD8CEBC);
  static const accent = Color(0xFFE8664F);
  static const accent2 = Color(0xFFF0836F);
  static const gold = Color(0xFFE3A34C);
  static const wii = Color(0xFF4FB8E0);
  static const wii2 = Color(0xFF8FE0F5);
  static const wiiDeep = Color(0xFF2E9BC4);
  static const wiiInk = Color(0xFF177A9E);
  // .wii-btn / .btn-primary gradient — same in light+dark, "the color centerpiece".
  static const wiiBtnTop = Color(0xFF45ADDD);
  static const wiiBtnBottom = Color(0xFF187AA5);
}

abstract final class HokagoRadii {
  static const tile = 16.0;
  static const panel = 22.0;
  static const hero = 28.0;
  static const pill = 999.0;
}

/// Same purpose-named scale as apps/web/tailwind.config.ts's fontSize block —
/// font-display (Zen Maru Gothic) for headline-tier text, the default body
/// font (Plus Jakarta Sans) for everything else, font-mono (JetBrains Mono)
/// for uppercase kicker labels. Pairing verified against actual web usage
/// (DetailView.tsx/HomeView.tsx: text-title/-section/-title-xl always ride
/// with font-display, text-kicker always with font-mono).
abstract final class HokagoText {
  static const _display = 'Zen Maru Gothic';
  static const _sans = 'Plus Jakarta Sans';
  static const _mono = 'JetBrains Mono';

  static const display = TextStyle(
      fontFamily: _display, fontSize: 48, height: 1.04, letterSpacing: -0.72, fontWeight: FontWeight.w700, color: HokagoColors.ink);
  static const titleXl = TextStyle(
      fontFamily: _display, fontSize: 40, height: 1.04, letterSpacing: -0.4, fontWeight: FontWeight.w900, color: HokagoColors.ink);
  static const title = TextStyle(
      fontFamily: _display, fontSize: 28, height: 1.15, letterSpacing: -0.28, fontWeight: FontWeight.w700, color: HokagoColors.ink);
  static const section = TextStyle(
      fontFamily: _display, fontSize: 21, height: 1.2, fontWeight: FontWeight.w700, color: HokagoColors.ink);
  static const cardTitle = TextStyle(fontFamily: _sans, fontSize: 13.5, height: 1.3, fontWeight: FontWeight.w600, color: HokagoColors.ink);
  static const body = TextStyle(fontFamily: _sans, fontSize: 14.5, height: 1.75, color: HokagoColors.ink2);
  static const meta = TextStyle(fontFamily: _sans, fontSize: 13, height: 1.5, color: HokagoColors.ink3);
  static const small = TextStyle(fontFamily: _sans, fontSize: 12, height: 1.4, color: HokagoColors.ink3);
  static const kicker = TextStyle(
      fontFamily: _mono, fontSize: 10.5, height: 1.4, fontWeight: FontWeight.w700, letterSpacing: 1.47, color: HokagoColors.gold);
}

/// Matches app.css's light --shadow-panel: inset top highlight + two-layer
/// soft warm drop shadow. Used by HokagoPanel and any "floating" card.
const hokagoPanelShadow = [
  BoxShadow(color: Color(0xE6FFFFFF), blurRadius: 0, spreadRadius: 0, offset: Offset(0, 1.5)),
  BoxShadow(color: Color(0x24785038), blurRadius: 6, spreadRadius: -2, offset: Offset(0, 2)),
  BoxShadow(color: Color(0x59785038), blurRadius: 44, spreadRadius: -18, offset: Offset(0, 18)),
];

ThemeData buildHokagoTheme() {
  final base = ThemeData.light(useMaterial3: true);
  final colorScheme = base.colorScheme.copyWith(
    surface: HokagoColors.paper,
    primary: HokagoColors.accent,
    secondary: HokagoColors.wii,
    error: const Color(0xFFD9634A),
    onSurface: HokagoColors.ink,
  );
  return base.copyWith(
    // The wallpaper is painted once behind every route (see HokagoBackground
    // in app.dart's MaterialApp.builder) — Scaffold stays transparent so it
    // shows through, matching the web's body::before wallpaper layer.
    scaffoldBackgroundColor: Colors.transparent,
    colorScheme: colorScheme,
    textTheme: base.textTheme.apply(
      fontFamily: 'Plus Jakarta Sans',
      bodyColor: HokagoColors.ink,
      displayColor: HokagoColors.ink,
    ),
    appBarTheme: const AppBarTheme(
      backgroundColor: Colors.transparent,
      surfaceTintColor: Colors.transparent,
      foregroundColor: HokagoColors.ink,
      elevation: 0,
      titleTextStyle: TextStyle(fontFamily: 'Zen Maru Gothic', fontSize: 21, fontWeight: FontWeight.w700, color: HokagoColors.ink),
    ),
    cardTheme: CardThemeData(
      color: HokagoColors.card,
      elevation: 0,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(HokagoRadii.tile)),
    ),
    // Stock ElevatedButton kept as a fallback where a WiiButton (the real
    // .btn-primary pill) isn't wired yet.
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        backgroundColor: HokagoColors.accent,
        foregroundColor: Colors.white,
        shape: const RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(HokagoRadii.pill))),
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
        textStyle: const TextStyle(fontFamily: 'Plus Jakarta Sans', fontWeight: FontWeight.w700, fontSize: 14.5),
      ),
    ),
    // .input: pill radius, soft paper fill, wii-blue focus ring.
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: const Color(0xFFFBF8F1),
      contentPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(HokagoRadii.pill),
        borderSide: const BorderSide(color: HokagoColors.line, width: 1.5),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(HokagoRadii.pill),
        borderSide: const BorderSide(color: HokagoColors.line, width: 1.5),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(HokagoRadii.pill),
        borderSide: const BorderSide(color: HokagoColors.wii, width: 1.5),
      ),
      labelStyle: const TextStyle(color: HokagoColors.ink3),
      hintStyle: const TextStyle(color: HokagoColors.ink3),
    ),
    progressIndicatorTheme: const ProgressIndicatorThemeData(color: HokagoColors.wii),
    dividerTheme: const DividerThemeData(color: HokagoColors.line, space: 1),
  );
}
