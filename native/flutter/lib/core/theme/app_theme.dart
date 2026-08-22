import 'package:flutter/material.dart';

/// hokago design tokens, ported directly from apps/web/src/app.css's `:root`
/// (light) and `.dark` scopes + component classes (.btn-primary, .panel,
/// .input). Both themes are real — the web has a persisted light/dark
/// toggle (`useTheme.tsx`), and this app mirrors that rather than picking
/// one. `HokagoColors` fields are getters over a swappable current palette
/// (not per-file Theme.of(context) lookups) so every widget that already
/// reads `HokagoColors.x` keeps working unchanged when the mode flips —
/// call `HokagoColors.setDark(bool)` then rebuild (ThemeModeController does
/// this). Simpler than threading a ThemeExtension through every widget;
/// the tradeoff is a global mutable instead of an InheritedWidget — fine at
/// this app's size, revisit if multi-window/isolate rendering ever matters.
class _Palette {
  const _Palette({
    required this.bg,
    required this.paper,
    required this.paper2,
    required this.card,
    required this.ink,
    required this.ink2,
    required this.ink3,
    required this.line,
    required this.line2,
    required this.accent,
    required this.accent2,
    required this.gold,
    required this.wii,
    required this.wii2,
    required this.wiiDeep,
    required this.wiiInk,
    required this.panelShadow,
    required this.panelFill,
    required this.panelBorder,
    required this.ghostFill,
    required this.ghostBorder,
    required this.wallpaperAuras,
  });

  final Color bg, paper, paper2, card, ink, ink2, ink3, line, line2, accent, accent2, gold, wii, wii2, wiiDeep, wiiInk;
  final List<BoxShadow> panelShadow;
  final Color panelFill, panelBorder, ghostFill, ghostBorder;
  final List<({double cx, double cy, double rx, double ry, Color color})> wallpaperAuras;
}

const _lightPanelShadow = [
  BoxShadow(color: Color(0xE6FFFFFF), blurRadius: 0, spreadRadius: 0, offset: Offset(0, 1.5)),
  BoxShadow(color: Color(0x24785038), blurRadius: 6, spreadRadius: -2, offset: Offset(0, 2)),
  BoxShadow(color: Color(0x59785038), blurRadius: 44, spreadRadius: -18, offset: Offset(0, 18)),
];

const _darkPanelShadow = [
  BoxShadow(color: Color(0x0DFFFFFF), blurRadius: 0, spreadRadius: 0, offset: Offset(0, 1.5)),
  BoxShadow(color: Color(0x73000000), blurRadius: 6, spreadRadius: -2, offset: Offset(0, 2)),
  BoxShadow(color: Color(0x99000000), blurRadius: 44, spreadRadius: -18, offset: Offset(0, 18)),
];

const _light = _Palette(
  bg: Color(0xFFF5EFE4),
  paper: Color(0xFFF6F0E6),
  paper2: Color(0xFFEFE7D8),
  card: Color(0xFFFFFFFF),
  ink: Color(0xFF35302B),
  ink2: Color(0xFF72695F),
  ink3: Color(0xFF8B8177),
  line: Color(0xFFE6DDCE),
  line2: Color(0xFFD8CEBC),
  accent: Color(0xFFE8664F),
  accent2: Color(0xFFF0836F),
  gold: Color(0xFFE3A34C),
  wii: Color(0xFF4FB8E0),
  wii2: Color(0xFF8FE0F5),
  wiiDeep: Color(0xFF2E9BC4),
  wiiInk: Color(0xFF177A9E),
  panelShadow: _lightPanelShadow,
  panelFill: Color(0xDBFFFFFF),
  panelBorder: Color(0xF2FFFFFF),
  ghostFill: Color(0xE0FFFFFF),
  ghostBorder: Color(0xE6FFFFFF),
  wallpaperAuras: [
    (cx: 0.5, cy: -0.10, rx: 1.30, ry: 0.70, color: Color(0xF2FFF8E9)),
    (cx: 0.92, cy: -0.04, rx: 0.48, ry: 0.42, color: Color(0x384FB8E0)),
    (cx: -0.02, cy: 0.24, rx: 0.42, ry: 0.38, color: Color(0x24F0836F)),
    (cx: 0.5, cy: 0.70, rx: 0.36, ry: 0.50, color: Color(0x1AE3A34C)),
  ],
);

const _dark = _Palette(
  bg: Color(0xFF171410),
  paper: Color(0xFF26221D),
  paper2: Color(0xFF2E2A24),
  card: Color(0xFF2B2722),
  ink: Color(0xFFF1EADB),
  ink2: Color(0xFFBCB2A2),
  ink3: Color(0xFF857D6F),
  line: Color(0xFF3A352E),
  line2: Color(0xFF4A443B),
  accent: Color(0xFFF07B63),
  accent2: Color(0xFFF49B87),
  gold: Color(0xFFEDB866),
  wii: Color(0xFF63C3E6),
  wii2: Color(0xFFA5E7F8),
  wiiDeep: Color(0xFF3FAED6),
  wiiInk: Color(0xFF6ECFF2),
  panelShadow: _darkPanelShadow,
  panelFill: Color(0xE02B2722),
  panelBorder: Color(0x12FFFFFF),
  ghostFill: Color(0xE0262219),
  ghostBorder: Color(0x1AFFFFFF),
  wallpaperAuras: [
    (cx: 0.5, cy: -0.10, rx: 1.30, ry: 0.70, color: Color(0x0DFFF4E0)),
    (cx: 0.92, cy: -0.04, rx: 0.48, ry: 0.42, color: Color(0x1763C3E6)),
    (cx: -0.02, cy: 0.24, rx: 0.42, ry: 0.38, color: Color(0x0DF0836F)),
    (cx: 0.5, cy: 0.70, rx: 0.36, ry: 0.50, color: Color(0x0BEDB866)),
  ],
);

abstract final class HokagoColors {
  static _Palette _current = _light;
  static bool isDark = false;

  static void setDark(bool dark) {
    isDark = dark;
    _current = dark ? _dark : _light;
  }

  static Color get bg => _current.bg;
  static Color get paper => _current.paper;
  static Color get paper2 => _current.paper2;
  static Color get card => _current.card;
  static Color get ink => _current.ink;
  static Color get ink2 => _current.ink2;
  static Color get ink3 => _current.ink3;
  static Color get line => _current.line;
  static Color get line2 => _current.line2;
  static Color get accent => _current.accent;
  static Color get accent2 => _current.accent2;
  static Color get gold => _current.gold;
  static Color get wii => _current.wii;
  static Color get wii2 => _current.wii2;
  static Color get wiiDeep => _current.wiiDeep;
  static Color get wiiInk => _current.wiiInk;
  static Color get panelFill => _current.panelFill;
  static Color get panelBorder => _current.panelBorder;
  static Color get ghostFill => _current.ghostFill;
  static Color get ghostBorder => _current.ghostBorder;
  static List<({double cx, double cy, double rx, double ry, Color color})> get wallpaperAuras => _current.wallpaperAuras;
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

  static TextStyle get display =>
      TextStyle(fontFamily: _display, fontSize: 48, height: 1.04, letterSpacing: -0.72, fontWeight: FontWeight.w700, color: HokagoColors.ink);
  static TextStyle get titleXl =>
      TextStyle(fontFamily: _display, fontSize: 40, height: 1.04, letterSpacing: -0.4, fontWeight: FontWeight.w900, color: HokagoColors.ink);
  static TextStyle get title =>
      TextStyle(fontFamily: _display, fontSize: 28, height: 1.15, letterSpacing: -0.28, fontWeight: FontWeight.w700, color: HokagoColors.ink);
  static TextStyle get section => TextStyle(fontFamily: _display, fontSize: 21, height: 1.2, fontWeight: FontWeight.w700, color: HokagoColors.ink);
  static TextStyle get cardTitle => TextStyle(fontFamily: _sans, fontSize: 13.5, height: 1.3, fontWeight: FontWeight.w600, color: HokagoColors.ink);
  static TextStyle get body => TextStyle(fontFamily: _sans, fontSize: 14.5, height: 1.75, color: HokagoColors.ink2);
  static TextStyle get meta => TextStyle(fontFamily: _sans, fontSize: 13, height: 1.5, color: HokagoColors.ink3);
  static TextStyle get small => TextStyle(fontFamily: _sans, fontSize: 12, height: 1.4, color: HokagoColors.ink3);
  static TextStyle get kicker =>
      TextStyle(fontFamily: _mono, fontSize: 10.5, height: 1.4, fontWeight: FontWeight.w700, letterSpacing: 1.47, color: HokagoColors.gold);
}

/// app.css's --shadow-panel for the *current* mode. A getter (not a const)
/// for the same reason as HokagoColors — must reflect HokagoColors.setDark.
List<BoxShadow> get hokagoPanelShadow => HokagoColors._current.panelShadow;

ThemeData buildHokagoTheme() {
  final base = HokagoColors.isDark ? ThemeData.dark(useMaterial3: true) : ThemeData.light(useMaterial3: true);
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
    appBarTheme: AppBarTheme(
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
      fillColor: HokagoColors.isDark ? const Color(0xFF1F1C17) : const Color(0xFFFBF8F1),
      contentPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(HokagoRadii.pill),
        borderSide: BorderSide(color: HokagoColors.line, width: 1.5),
      ),
      enabledBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(HokagoRadii.pill),
        borderSide: BorderSide(color: HokagoColors.line, width: 1.5),
      ),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.circular(HokagoRadii.pill),
        borderSide: BorderSide(color: HokagoColors.wii, width: 1.5),
      ),
      labelStyle: TextStyle(color: HokagoColors.ink3),
      hintStyle: TextStyle(color: HokagoColors.ink3),
    ),
    progressIndicatorTheme: ProgressIndicatorThemeData(color: HokagoColors.wii),
    dividerTheme: DividerThemeData(color: HokagoColors.line, space: 1),
    // The web is an SPA — route changes are instant, no push/crossfade
    // animation at all. A crossfade (tried first) still composites the old
    // and new page's transparent-Scaffold content over the shared wallpaper
    // simultaneously for the transition's duration, which read as visible
    // artifacting/mixing between the two pages, not a clean fade — an
    // instant swap (no animation, matching the web exactly) removes the
    // compositing window entirely instead of tuning it.
    pageTransitionsTheme: const PageTransitionsTheme(
      builders: {
        TargetPlatform.iOS: _InstantPageTransitionsBuilder(),
        TargetPlatform.android: _InstantPageTransitionsBuilder(),
      },
    ),
  );
}

class _InstantPageTransitionsBuilder extends PageTransitionsBuilder {
  const _InstantPageTransitionsBuilder();

  @override
  Widget buildTransitions<T>(
    PageRoute<T> route,
    BuildContext context,
    Animation<double> animation,
    Animation<double> secondaryAnimation,
    Widget child,
  ) {
    return child;
  }
}
