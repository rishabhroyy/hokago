import assert from "node:assert/strict";
import { test } from "node:test";

import { isSeriesLikeTitle, parseAnicliQuery } from "./anicli.js";

test("parseAnicliQuery leaves clean ani-cli queries untouched", () => {
  assert.deepEqual(parseAnicliQuery("Frieren"), { title: "Frieren", year: null, sub: null, season: null });
  assert.deepEqual(parseAnicliQuery("Frieren S2"), { title: "Frieren", year: null, sub: "Season 2", season: 2 });
  assert.deepEqual(parseAnicliQuery("Frieren Season 2"), { title: "Frieren", year: null, sub: "Season 2", season: 2 });
  assert.deepEqual(parseAnicliQuery("Anohana (2011)"), { title: "Anohana", year: 2011, sub: null, season: null });
});

test("parseAnicliQuery strips quality tails that previously forked duplicate folders", () => {
  assert.deepEqual(parseAnicliQuery("Anohana BD 1080p").title, "Anohana");
  assert.deepEqual(parseAnicliQuery("Anohana (2011) BD 1080p"), { title: "Anohana", year: 2011, sub: null, season: null });
  assert.deepEqual(parseAnicliQuery("Frieren Season 2 BD 1080p"), { title: "Frieren", year: null, sub: "Season 2", season: 2 });
  // Glued suffix seen in the wild ("1080pH") must not survive as a folder fragment.
  const glued = parseAnicliQuery("Judas Sewayaki Kitsune no Senko-san The Helpful Fox Senko-san Season 1 BD 1080pH");
  assert.equal(glued.title, "Judas Sewayaki Kitsune no Senko-san The Helpful Fox Senko-san");
  assert.equal(glued.sub, "Season 1");
  assert.equal(glued.season, 1);
});

test("parseAnicliQuery strips release groups, brackets, and -GROUP suffixes", () => {
  assert.equal(parseAnicliQuery("[SubsPlease] Frieren").title, "Frieren");
  assert.equal(parseAnicliQuery("Frieren [abc123] 1080p").title, "Frieren");
  assert.equal(parseAnicliQuery("Frieren 1080p-GROUP").title, "Frieren");
  // No quality present: a legitimate " - Alicization" tail must survive.
  assert.equal(parseAnicliQuery("Sword Art Online - Alicization").title, "Sword Art Online - Alicization");
});

test("parseAnicliQuery strips per-episode suffixes so they never become folders", () => {
  assert.equal(parseAnicliQuery("Anohana - 01").title, "Anohana");
  assert.equal(parseAnicliQuery("Anohana Episode 12").title, "Anohana");
  assert.equal(parseAnicliQuery("[SubsPlease] Frieren - 01 (1080p)").title, "Frieren");
  assert.equal(parseAnicliQuery("Frieren S2 - 05").sub, "Season 2");
  // Sequel numbers are not episodes.
  assert.equal(parseAnicliQuery("Spice and Wolf 2").title, "Spice and Wolf 2");
  // A trailing year is not an episode.
  assert.deepEqual(parseAnicliQuery("Anohana (2011)").year, 2011);
});

test("parseAnicliQuery reads scene-style S02E05 provider titles", () => {
  const parsed = parseAnicliQuery("Frieren S02E05 BD 1080p");
  assert.equal(parsed.title, "Frieren");
  assert.equal(parsed.sub, "Season 2");
  assert.equal(parsed.season, 2);
});

test("parseAnicliQuery never returns release junk as a series title", () => {
  const parsed = parseAnicliQuery("[X] BD 1080p");
  assert.notEqual(parsed.title.includes("BD"), true);
  assert.notEqual(parsed.title.includes("1080p"), true);
});

test("parseAnicliQuery extracts bare and mid-string years so they never poison matching", () => {
  assert.deepEqual(parseAnicliQuery("Anohana 2011"), { title: "Anohana", year: 2011, sub: null, season: null });
  assert.deepEqual(parseAnicliQuery("Anohana 2011 BD 1080p"), { title: "Anohana", year: 2011, sub: null, season: null });
  const mid = parseAnicliQuery("Anohana (2011) Season 1 BD 1080p");
  assert.equal(mid.title, "Anohana");
  assert.equal(mid.year, 2011);
  assert.equal(mid.sub, "Season 1");
  // Year revealed only after an episode suffix is stripped.
  assert.deepEqual(parseAnicliQuery("Anohana 2011 - 01"), { title: "Anohana", year: 2011, sub: null, season: null });
  // Not years: sequel numbers survive, long-runner episodes strip to the series.
  assert.equal(parseAnicliQuery("Spice and Wolf 2").year, null);
  assert.equal(parseAnicliQuery("One Piece 1071").title, "One Piece");
  assert.equal(parseAnicliQuery("One Piece - 1071").title, "One Piece");
});

test("parseAnicliQuery extracts bracketed years instead of dropping them with the groups", () => {
  assert.deepEqual(parseAnicliQuery("Anohana [2011]"), { title: "Anohana", year: 2011, sub: null, season: null });
  assert.deepEqual(parseAnicliQuery("Anohana [2011] BD 1080p"), { title: "Anohana", year: 2011, sub: null, season: null });
  const mid = parseAnicliQuery("Anohana [2011] Season 1");
  assert.equal(mid.title, "Anohana");
  assert.equal(mid.year, 2011);
  assert.equal(mid.sub, "Season 1");
});

test("isSeriesLikeTitle rejects episode identity so it can never name a folder", () => {
  assert.equal(isSeriesLikeTitle("Frieren"), true);
  assert.equal(isSeriesLikeTitle("Frieren: Beyond Journey's End"), true);
  assert.equal(isSeriesLikeTitle("01"), false);
  assert.equal(isSeriesLikeTitle("01-28"), false);
  assert.equal(isSeriesLikeTitle("Episode 5"), false);
  assert.equal(isSeriesLikeTitle("EP12"), false);
  assert.equal(isSeriesLikeTitle("S02E05"), false);
  assert.equal(isSeriesLikeTitle("anicli"), false);
  assert.equal(isSeriesLikeTitle(""), false);
});
