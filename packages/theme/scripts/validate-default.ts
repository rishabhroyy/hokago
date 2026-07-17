import { defaultTheme, validateTheme } from "../src/tokens.js";

const result = validateTheme(defaultTheme);

if (!result.ok) {
  console.error("defaultTheme failed validation:");
  for (const err of result.errors) console.error(`  - ${err}`);
  process.exit(1);
}

console.log("defaultTheme: valid");
