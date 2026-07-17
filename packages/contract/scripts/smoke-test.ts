import { createHokagoClient } from "../src/client.js";

const client = createHokagoClient("http://localhost:3000");
const { data, error } = await client.GET("/health");

if (error || data?.status !== "ok") {
  console.error("smoke test failed:", error ?? data);
  process.exit(1);
}

console.log("generated client -> /health:", data);
