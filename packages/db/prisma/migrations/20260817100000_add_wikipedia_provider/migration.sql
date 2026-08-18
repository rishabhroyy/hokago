-- Wikipedia joins the Provider enum: keyless movie metadata (REST summary +
-- infobox) — the MOVIE chain previously only had the anime carve-out to fall
-- back on, which rejects every non-anime title.
ALTER TYPE "Provider" ADD VALUE 'WIKIPEDIA';