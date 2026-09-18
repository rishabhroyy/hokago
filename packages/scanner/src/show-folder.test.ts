import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { resolveShowFolderPath } from "./show-folder.js";

test("resolveShowFolderPath: normal resolution", () => {
  const result = resolveShowFolderPath("/media/anime", "Frieren: Beyond Journey's End");
  assert.equal(result, path.resolve("/media/anime", "Frieren: Beyond Journey's End"));
});

test("resolveShowFolderPath: rejects a ../ escape", () => {
  assert.equal(resolveShowFolderPath("/media/anime", "../../etc"), null);
});

test("resolveShowFolderPath: rejects an empty title", () => {
  assert.equal(resolveShowFolderPath("/media/anime", ""), null);
  assert.equal(resolveShowFolderPath("/media/anime", "   "), null);
});

test("resolveShowFolderPath: rejects a title that resolves to the root itself", () => {
  assert.equal(resolveShowFolderPath("/media/anime", "."), null);
});
