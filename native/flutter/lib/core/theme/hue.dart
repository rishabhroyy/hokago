import 'package:flutter/material.dart';

import '../widgets/hokago_icon.dart';

/// Deterministic per-title pastel gradient + glyph — ui/Tile.tsx's
/// hueFor/iconFor, ported exactly (same string hash, same 6 gradient pairs,
/// same 8-icon pool) so a title gets the same "channel" look on every platform.
const List<List<Color>> hokagoHues = [
  [Color(0xFFF4A98C), Color(0xFFEE8E6C)],
  [Color(0xFFED9DAE), Color(0xFFE2879A)],
  [Color(0xFFEFCB79), Color(0xFFE4B457)],
  [Color(0xFFA9CDA0), Color(0xFF89B683)],
  [Color(0xFF9BCBE0), Color(0xFF78B3D0)],
  [Color(0xFFF09E86), Color(0xFFE27862)],
];

int _hash(String id) {
  var h = 0;
  for (final code in id.codeUnits) {
    h = ((h * 31) + code).toSigned(32);
  }
  return h.abs();
}

List<Color> hueFor(String id) => hokagoHues[_hash(id) % hokagoHues.length];

String iconFor(String id) => hokagoIconPool[_hash(id) % hokagoIconPool.length];
