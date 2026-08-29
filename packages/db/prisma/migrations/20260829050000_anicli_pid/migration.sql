-- Persist the detached downloader's process-group pid so a hard worker crash
-- (OOM, SIGKILL, docker stop grace timeout) can be reconciled: the next boot's
-- reconciler kills the orphaned downloader (which has no timeout — the
-- in-process one died with the worker — and can keep writing to staging with
-- --fragment-retries infinite). Null on clean exit.
ALTER TABLE "anicli_downloads" ADD COLUMN "pid" INTEGER;
