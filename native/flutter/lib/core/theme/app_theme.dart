import 'package:flutter/cupertino.dart' show CupertinoPageTransitionsBuilder;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// hokago design tokens, ported from apps/web/src/app.css's `.dark` scope +
/// component classes (.btn-primary, .btn-ghost, .panel, .input). The web is
/// dark-only (CLAUDE.md invariant #6), so this is too — one palette, consts.
abstract final class HokagoColors {
  static const bg = Color(0xFF121110);
  static const paper = Color(0xFF1B1A18);
  static const paper2 = Color(0xFF232220);
  static const card = Color(0xFF1F1E1C);
  static const ink = Color(0xFFF3F0EA);
  static const ink2 = Color(0xFFC4BFB6);
  static const ink3 = Color(0xFF948F86);
  static const line = Color(0xFF2C2B28);
  static const line2 = Color(0xFF393734);
  static const accent = Color(0xFFF07B63);
  static const accent2 = Color(0xFFF49B87);
  static const gold = Color(0xFFEDB866);
  static const wii = Color(0xFF63C3E6);
  static const wii2 = Color(0xFFA5E7F8);
  static const wiiDeep = Color(0xFF3FAED6);
  static const wiiInk = Color(0xFF6ECFF2);
  // .dark .panel / .dark .btn-ghost
  static const panelFill = Color(0xE02B2722);
  static const panelBorder = Color(0x12FFFFFF);
  static const ghostFill = Color(0xE026221D);
  static const ghostBorder = Color(0x1AFFFFFF);
  // .wii-btn / .btn-primary gradient — "the color centerpiece".
  static const wiiBtnTop = Color(0xFF45ADDD);
  static const wiiBtnBottom = Color(0xFF187AA5);
  // the full-bleed art shade (Hero.tsx's rgba(18,17,16,…) legibility gradient)
  static const shade = Color(0xFF121110);
}

abstract final class HokagoRadii {
  static const tile = 16.0;
  static const panel = 22.0;
  static const hero = 28.0;
  static const pill = 999.0;
}

abstract final class HokagoMotion {
  /// --e-snap: press / hover / pop (the overshooting Wii spring).
  static const snap = Cubic(.4, 1.4, .5, 1);

  /// --e: fades / view transitions.
  static const smooth = Cubic(.4, 0, .2, 1);
}

/// Same purpose-named scale as apps/web/tailwind.config.ts's fontSize block —
/// Zen Maru Gothic for headline-tier text, Plus Jakarta Sans for everything
/// else, JetBrains Mono for the small mono badges (EP 3, 24m).
abstract final class HokagoText {
  static const _display = 'Zen Maru Gothic';
  static const _sans = 'Plus Jakarta Sans';
  static const _mono = 'JetBrains Mono';

  static const display =
      TextStyle(fontFamily: _display, fontSize: 48, height: 1.04, letterSpacing: -0.72, fontWeight: FontWeight.w700, color: HokagoColors.ink);
  static const titleXl =
      TextStyle(fontFamily: _display, fontSize: 40, height: 1.04, letterSpacing: -0.4, fontWeight: FontWeight.w700, color: HokagoColors.ink);
  static const title =
      TextStyle(fontFamily: _display, fontSize: 28, height: 1.15, letterSpacing: -0.28, fontWeight: FontWeight.w700, color: HokagoColors.ink);
  static const section = TextStyle(fontFamily: _display, fontSize: 21, height: 1.2, fontWeight: FontWeight.w700, color: HokagoColors.ink);
  static const cardTitle = TextStyle(fontFamily: _sans, fontSize: 13.5, height: 1.3, fontWeight: FontWeight.w700, color: HokagoColors.ink);
  static const body = TextStyle(fontFamily: _sans, fontSize: 14.5, height: 1.75, color: HokagoColors.ink2);
  static const meta = TextStyle(fontFamily: _sans, fontSize: 13, height: 1.5, fontWeight: FontWeight.w500, color: HokagoColors.ink2);
  static const small = TextStyle(fontFamily: _sans, fontSize: 12, height: 1.4, color: HokagoColors.ink3);
  static const kicker =
      TextStyle(fontFamily: _mono, fontSize: 10.5, height: 1.4, fontWeight: FontWeight.w700, letterSpacing: 0.4, color: HokagoColors.ink);
  static const button = TextStyle(fontFamily: _sans, fontSize: 14.5, fontWeight: FontWeight.w700);
}

/// app.css's `.dark` --shadow-panel (minus the inset sheen, drawn as a top
/// border highlight where it matters — Flutter has no inset shadow).
const hokagoPanelShadow = [
  BoxShadow(color: Color(0x73000000), blurRadius: 6, spreadRadius: -2, offset: Offset(0, 2)),
  BoxShadow(color: Color(0xA6000000), blurRadius: 44, spreadRadius: -18, offset: Offset(0, 18)),
];

/// tailwind's shadow-wii-ring: the blue Wii cursor ring — hover on the web,
/// keyboard / D-pad focus here.
const hokagoWiiRing = [
  BoxShadow(color: HokagoColors.bg, spreadRadius: 2.5),
  BoxShadow(color: Color(0xFF4FB8E0), spreadRadius: 5),
  BoxShadow(color: Color(0x734FB8E0), blurRadius: 18, spreadRadius: 2),
];

const hokagoSystemOverlay = SystemUiOverlayStyle(
  statusBarColor: Colors.transparent,
  statusBarIconBrightness: Brightness.light,
  statusBarBrightness: Brightness.dark,
  systemNavigationBarColor: Colors.transparent,
  systemNavigationBarIconBrightness: Brightness.light,
  systemNavigationBarContrastEnforced: false,
);

ThemeData buildHokagoTheme() {
  final base = ThemeData.dark(useMaterial3: true);
  final colorScheme = base.colorScheme.copyWith(
    surface: HokagoColors.paper,
    surfaceContainerHighest: HokagoColors.paper2,
    primary: HokagoColors.wii,
    onPrimary: Colors.white,
    secondary: HokagoColors.accent,
    error: HokagoColors.accent,
    onSurface: HokagoColors.ink,
    outline: HokagoColors.line2,
  );
  OutlineInputBorder pill(Color c) =>
      OutlineInputBorder(borderRadius: BorderRadius.circular(HokagoRadii.pill), borderSide: BorderSide(color: c, width: 1.5));
  return base.copyWith(
    // The wallpaper is painted once behind every route (HokagoBackground in
    // app.dart's MaterialApp.builder) — Scaffold stays transparent over it.
    scaffoldBackgroundColor: Colors.transparent,
    canvasColor: HokagoColors.paper,
    colorScheme: colorScheme,
    splashFactory: InkSparkle.splashFactory,
    textTheme: base.textTheme.apply(fontFamily: 'Plus Jakarta Sans', bodyColor: HokagoColors.ink, displayColor: HokagoColors.ink),
    appBarTheme: const AppBarTheme(
      backgroundColor: Colors.transparent,
      surfaceTintColor: Colors.transparent,
      foregroundColor: HokagoColors.ink,
      elevation: 0,
      scrolledUnderElevation: 0,
      systemOverlayStyle: hokagoSystemOverlay,
      titleTextStyle: HokagoText.title,
    ),
    bottomSheetTheme: const BottomSheetThemeData(
      backgroundColor: HokagoColors.paper,
      surfaceTintColor: Colors.transparent,
      showDragHandle: true,
      dragHandleColor: HokagoColors.line2,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(HokagoRadii.hero))),
    ),
    dialogTheme: const DialogThemeData(
      backgroundColor: HokagoColors.paper2,
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.all(Radius.circular(HokagoRadii.panel))),
      titleTextStyle: HokagoText.section,
      contentTextStyle: HokagoText.body,
    ),
    snackBarTheme: SnackBarThemeData(
      behavior: SnackBarBehavior.floating,
      backgroundColor: HokagoColors.paper2,
      contentTextStyle: HokagoText.meta.copyWith(color: HokagoColors.ink),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(HokagoRadii.pill), side: const BorderSide(color: HokagoColors.line2)),
      insetPadding: const EdgeInsets.fromLTRB(16, 0, 16, 96),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(foregroundColor: HokagoColors.ink2, textStyle: HokagoText.meta.copyWith(fontWeight: FontWeight.w700)),
    ),
    listTileTheme: const ListTileThemeData(
      iconColor: HokagoColors.ink2,
      titleTextStyle: HokagoText.cardTitle,
      subtitleTextStyle: HokagoText.small,
    ),
    // .dark .input: pill radius, paper fill, wii-blue focus ring.
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: HokagoColors.paper,
      contentPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
      border: pill(HokagoColors.line),
      enabledBorder: pill(HokagoColors.line),
      focusedBorder: pill(HokagoColors.wii),
      labelStyle: const TextStyle(color: HokagoColors.ink3),
      floatingLabelStyle: const TextStyle(color: HokagoColors.wii),
      hintStyle: const TextStyle(color: HokagoColors.ink3),
    ),
    textSelectionTheme: const TextSelectionThemeData(
      cursorColor: HokagoColors.wii,
      selectionColor: Color(0x5263C3E6),
      selectionHandleColor: HokagoColors.wii,
    ),
    progressIndicatorTheme: const ProgressIndicatorThemeData(color: HokagoColors.wii, linearTrackColor: HokagoColors.line),
    dividerTheme: const DividerThemeData(color: HokagoColors.line, space: 1),
    switchTheme: SwitchThemeData(
      thumbColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? Colors.white : HokagoColors.ink3),
      trackColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? HokagoColors.wiiDeep : HokagoColors.line),
    ),
    radioTheme: RadioThemeData(
      fillColor: WidgetStateProperty.resolveWith((s) => s.contains(WidgetState.selected) ? HokagoColors.wii : HokagoColors.ink3),
    ),
    pageTransitionsTheme: const PageTransitionsTheme(
      builders: {
        TargetPlatform.android: FadeForwardsPageTransitionsBuilder(backgroundColor: HokagoColors.bg),
        TargetPlatform.iOS: CupertinoPageTransitionsBuilder(),
      },
    ),
  );
}
