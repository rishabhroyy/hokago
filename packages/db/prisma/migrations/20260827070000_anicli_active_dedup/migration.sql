-- Guard the ani-cli dedup race: at most ONE active (non-terminal) download
-- per (library, query). Two concurrent POSTs could both pass the check-then-
-- create window and enqueue the same show twice; this makes the second insert
-- a unique violation the API maps to 409. Terminal states (DONE/FAILED/
-- CANCELLED) are excluded so a show can be re-downloaded after it settles.
CREATE UNIQUE INDEX "anicli_downloads_active_library_query"
  ON "anicli_downloads" ("libraryId", "query")
  WHERE status IN ('QUEUED', 'SEARCHING', 'DOWNLOADING', 'IMPORTING');
