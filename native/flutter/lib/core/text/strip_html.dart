/// Provider-sourced descriptions (TVDB/AniList/etc.) sometimes carry literal
/// HTML (`<br>`, `<i>`, entities) that the web renders via dangerouslySetInnerHTML.
/// Flutter has no such thing for a plain Text — this converts the common
/// subset (line breaks + basic entities, tags stripped) to plain text.
/// ponytail: not a real HTML parser — good enough for synopsis paragraphs,
/// upgrade to flutter_html only if a description needs real inline styling.
String stripHtml(String input) {
  var s = input.replaceAll(RegExp(r'<br\s*/?>', caseSensitive: false), '\n');
  s = s.replaceAll(RegExp(r'</p>', caseSensitive: false), '\n\n');
  s = s.replaceAll(RegExp(r'<[^>]+>'), '');
  s = s
      .replaceAll('&nbsp;', ' ')
      .replaceAll('&amp;', '&')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&#39;', "'");
  return s.replaceAll(RegExp(r'\n{3,}'), '\n\n').trim();
}
