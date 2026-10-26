import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api/models/browse.dart';
import '../../core/session/session_controller.dart';
import '../../core/text/strip_html.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/hokago_icon.dart';
import '../../core/widgets/wii_button.dart';

const _providerLabels = {'TVMAZE': 'TVmaze', 'WIKIPEDIA': 'Wikipedia', 'ANILIST': 'AniList', 'MAL': 'MyAnimeList'};

/// FixMatchPanel.tsx: search the keyless providers by title and pin the
/// right entry (fixes wrong/missing artwork and metadata). The pin enqueues
/// the item's resolve job server-side; [onPinned] refetches the detail.
Future<void> showFixMatchSheet(BuildContext context, {required MediaItemDetail item, required VoidCallback onPinned}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (_) => _FixMatchSheet(item: item, onPinned: onPinned),
  );
}

class _FixMatchSheet extends ConsumerStatefulWidget {
  const _FixMatchSheet({required this.item, required this.onPinned});
  final MediaItemDetail item;
  final VoidCallback onPinned;
  @override
  ConsumerState<_FixMatchSheet> createState() => _FixMatchSheetState();
}

class _FixMatchSheetState extends ConsumerState<_FixMatchSheet> {
  late final _title = TextEditingController(text: widget.item.title);
  List<MetadataCandidate>? _results;
  bool _searching = false;
  String? _pinning;
  String? _error;

  @override
  void initState() {
    super.initState();
    _search();
  }

  @override
  void dispose() {
    _title.dispose();
    super.dispose();
  }

  Future<void> _search() async {
    if (_title.text.trim().isEmpty) return;
    setState(() {
      _searching = true;
      _error = null;
    });
    try {
      final results = await ref.read(sessionProvider.notifier).api.metadataSearch(
            title: _title.text.trim(),
            year: widget.item.year,
            kind: widget.item.kind == 'MOVIE' ? 'MOVIE' : 'SERIES',
          );
      if (mounted) setState(() => _results = results);
    } catch (_) {
      if (mounted) setState(() => _error = 'Search failed — try again in a moment.');
    } finally {
      if (mounted) setState(() => _searching = false);
    }
  }

  Future<void> _pin(MetadataCandidate c) async {
    setState(() => _pinning = '${c.provider}:${c.providerId}');
    try {
      await ref.read(sessionProvider.notifier).api.pinMetadataMatch(widget.item.id, c);
      if (!mounted) return;
      Navigator.pop(context);
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Match pinned — artwork and details refresh shortly')));
      widget.onPinned();
    } catch (_) {
      if (mounted) setState(() => _error = "Couldn't pin that match.");
    } finally {
      if (mounted) setState(() => _pinning = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final pinned = widget.item.externalIds.map((e) => '${e.provider}:${e.providerId}').toSet();
    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.75,
      maxChildSize: 0.95,
      builder: (context, scroll) => Padding(
        padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(context).bottom),
        child: ListView(
          controller: scroll,
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 32),
          children: [
            const Text('Fix match', style: HokagoText.title),
            const SizedBox(height: 4),
            const Text('Pick the right entry to fix artwork and details.', style: HokagoText.body),
            const SizedBox(height: 16),
            Row(children: [
              Expanded(
                child: TextField(
                  controller: _title,
                  textInputAction: TextInputAction.search,
                  decoration: const InputDecoration(hintText: 'Title'),
                  onSubmitted: (_) => _search(),
                ),
              ),
              const SizedBox(width: 10),
              WiiButton(icon: 'search', label: 'Search', compact: true, busy: _searching, onPressed: _search),
            ]),
            if (_error != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_error!, style: HokagoText.meta.copyWith(color: HokagoColors.accent))),
            const SizedBox(height: 16),
            if (_results != null && _results!.isEmpty && !_searching) const Text('No candidates — try a shorter or alternate title.', style: HokagoText.meta),
            for (final c in _results ?? const <MetadataCandidate>[])
              Padding(
                padding: const EdgeInsets.only(bottom: 10),
                child: Material(
                  color: HokagoColors.paper2,
                  borderRadius: BorderRadius.circular(18),
                  clipBehavior: Clip.antiAlias,
                  child: InkWell(
                    onTap: _pinning == null ? () => _pin(c) : null,
                    child: Padding(
                      padding: const EdgeInsets.all(12),
                      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Expanded(
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Text(c.year != null ? '${c.title} (${c.year})' : c.title, style: HokagoText.cardTitle.copyWith(fontSize: 14.5)),
                            const SizedBox(height: 2),
                            Text(_providerLabels[c.provider] ?? c.provider, style: HokagoText.small.copyWith(color: HokagoColors.wiiInk, fontWeight: FontWeight.w700)),
                            if (c.overview != null) ...[
                              const SizedBox(height: 6),
                              Text(stripHtml(c.overview!), maxLines: 3, overflow: TextOverflow.ellipsis, style: HokagoText.small.copyWith(color: HokagoColors.ink2)),
                            ],
                          ]),
                        ),
                        const SizedBox(width: 10),
                        if (_pinning == '${c.provider}:${c.providerId}')
                          const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                        else if (pinned.contains('${c.provider}:${c.providerId}'))
                          const HokagoIcon('check', size: 20, color: HokagoColors.wii),
                      ]),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
