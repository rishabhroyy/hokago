import createClient from "openapi-fetch";
import type { paths } from "../generated/schema.js";

export function createHokagoClient(baseUrl: string) {
  return createClient<paths>({ baseUrl });
}
