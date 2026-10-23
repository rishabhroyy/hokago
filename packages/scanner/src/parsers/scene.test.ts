import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanFolderTitle, parseScene } from "./scene.js";

test("cleanFolderTitle strips streaming WEB-DL release folders", () => {
  assert.deepEqual(cleanFolderTitle("Crash.Landing.on.You.S01.1080p.NF.WEB-DL.DDP2.0.H.264-NTb"), { title: "Crash Landing on You", year: null });
  assert.deepEqual(cleanFolderTitle("My.Demon.S01.COMPLETE.1080p.NF.WEB-DL.DDP2.0.x264-GRP"), { title: "My Demon", year: null });
  assert.deepEqual(cleanFolderTitle("Show.Name.2019.S02.1080p.AMZN.WEB-DL.DDP5.1.H.264-GRP"), { title: "Show Name", year: 2019 });
});

test("cleanFolderTitle leaves clean folders alone", () => {
  assert.deepEqual(cleanFolderTitle("The Complete Works"), { title: "The Complete Works", year: null });
  assert.deepEqual(cleanFolderTitle("Attack on Titan (2013)"), { title: "Attack on Titan", year: 2013 });
  assert.deepEqual(cleanFolderTitle("Sword Art Online - Alicization"), { title: "Sword Art Online - Alicization", year: null });
});

test("parseScene reads streaming WEB-DL episode filenames", () => {
  const p = parseScene("Show.Name.S01E03.720p.NF.WEB-DL.DD+5.1.x264-GRP.mkv");
  assert.equal(p.title, "Show Name");
  assert.equal(p.season, 1);
  assert.equal(p.episode, 3);
});

test("parseScene strips dotted codec/audio tokens from movie filenames", () => {
  const p = parseScene("Your.Name.2016.1080p.AMZN.WEB-DL.DDP5.1.H.264-GRP.mkv");
  assert.equal(p.title, "Your Name");
  assert.equal(p.year, 2016);
});

test("cleanFolderTitle strips lower-case scene release tags", () => {
  assert.deepEqual(cleanFolderTitle("show.name.s01.1080p.web.h264-grp"), { title: "show name", year: null });
});
