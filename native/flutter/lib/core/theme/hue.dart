import 'package:flutter/material.dart';

/// Deterministic per-title pastel gradient — ui/Tile.tsx's HUE_CLASS/hueFor,
/// ported exactly (same string hash, same 6 gradient pairs) so a given title
/// gets the same "channel" color on every platform.
const List<List<Color>> hokagoHues = [
  [Color(0xFFF4A98C), Color(0xFFEE8E6C)],
  [Color(0xFFED9DAE), Color(0xFFE2879A)],
  [Color(0xFFEFCB79), Color(0xFFE4B457)],
  [Color(0xFFA9CDA0), Color(0xFF89B683)],
  [Color(0xFF9BCBE0), Color(0xFF78B3D0)],
  [Color(0xFFF09E86), Color(0xFFE27862)],
];

List<Color> hueFor(String id) {
  int h = 0;
  for (final code in id.codeUnits) {
    h = ((h * 31) + code).toSigned(32);
  }
  final index = h.abs() % 6;
  return hokagoHues[index];
}
