import { mkdirSync, writeFileSync } from "node:fs";
import openapiTS, { astToString } from "openapi-typescript";
import { buildOpenApiDocument } from "../src/openapi.js";

mkdirSync(new URL("../generated/", import.meta.url), { recursive: true });

const doc = buildOpenApiDocument();
writeFileSync(
  new URL("../generated/openapi.json", import.meta.url),
  JSON.stringify(doc, null, 2)
);

const ast = await openapiTS(doc as unknown as Parameters<typeof openapiTS>[0]);
writeFileSync(new URL("../generated/schema.d.ts", import.meta.url), astToString(ast));

console.log("contract generated: generated/openapi.json + generated/schema.d.ts");
