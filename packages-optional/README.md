# packages-optional

Deliberately empty in the core repo. Design doc: docs/design.md §8.5, §19 Step 0.

AGPL-encumbered datasets (anime-offline-database, Fribb/anime-lists) and
non-commercial-restricted datasets (IMDb) are never vendored, bundled, or
committed here. An operator who wants them fetches the adapter at runtime
onto their own instance — that's a materially different license posture than
hokago redistributing them.

Adapters placed here implement the interfaces in `packages/metadata` and
nothing else in the core repo may depend on this directory.
