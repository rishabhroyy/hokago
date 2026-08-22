import 'package:flutter/material.dart';

/// hokago design tokens, ported from apps/web/src/app.css's `.dark` scope —
/// same palette everywhere, native typography (system font) instead of the
/// web's bundled Zen Maru/Plus Jakarta so each platform feels native.
abstract final class HokagoColors {
  static const bg = Color(0xFF171410);
  static const paper = Color(0xFF26221D);
  static const paper2 = Color(0xFF2E2A24);
  static const card = Color(0xFF2B2722);
  static const ink = Color(0xFFF1EADB);
  static const ink2 = Color(0xFFBCB2A2);
  static const ink3 = Color(0xFF857D6F);
  static const line = Color(0xFF3A352E);
  static const line2 = Color(0xFF4A443B);
  static const accent = Color(0xFFF07B63);
  static const accent2 = Color(0xFFF49B87);
  static const gold = Color(0xFFEDB866);
  static const wii = Color(0xFF63C3E6);
  static const wiiDeep = Color(0xFF3FAED6);
}

abstract final class HokagoRadii {
  static const tile = 16.0;
  static const panel = 22.0;
  static const hero = 28.0;
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

ThemeData buildHokagoTheme() {
  final base = ThemeData.dark(useMaterial3: true);
  final colorScheme = base.colorScheme.copyWith(
    surface: HokagoColors.paper,
    primary: HokagoColors.accent,
    secondary: HokagoColors.wii,
    error: const Color(0xFFE5735F),
    onSurface: HokagoColors.ink,
  );
  return base.copyWith(
    scaffoldBackgroundColor: HokagoColors.bg,
    colorScheme: colorScheme,
    textTheme: base.textTheme.apply(
      fontFamily: 'Plus Jakarta Sans',
      bodyColor: HokagoColors.ink,
      displayColor: HokagoColors.ink,
    ),
    appBarTheme: const AppBarTheme(
      backgroundColor: HokagoColors.bg,
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
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: ElevatedButton.styleFrom(
        backgroundColor: HokagoColors.accent,
        foregroundColor: Colors.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
        textStyle: const TextStyle(fontFamily: 'Plus Jakarta Sans', fontWeight: FontWeight.w600, fontSize: 15),
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: HokagoColors.paper2,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: const BorderSide(color: HokagoColors.line),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: const BorderSide(color: HokagoColors.line),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(14),
        borderSide: const BorderSide(color: HokagoColors.wii, width: 1.5),
      ),
      labelStyle: const TextStyle(color: HokagoColors.ink2),
    ),
    progressIndicatorTheme: const ProgressIndicatorThemeData(color: HokagoColors.accent),
    dividerTheme: const DividerThemeData(color: HokagoColors.line, space: 1),
  );
}
