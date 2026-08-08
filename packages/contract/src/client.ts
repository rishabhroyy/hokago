import createClient from "openapi-fetch";
import type { paths } from "../generated/schema.js";

export function createHokagoClient(
  baseUrl: string,
  options?: { fetch?: typeof globalThis.fetch },
) {
  return createClient<paths>({ baseUrl, ...options });
}
