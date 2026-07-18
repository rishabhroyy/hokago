import { Redis } from "ioredis";

let shared: Redis | null = null;

/** One shared Valkey connection per process — BullMQ Queue/Worker instances all reuse it. */
export function getConnection(): Redis {
  if (!shared) {
    shared = new Redis(process.env.VALKEY_URL ?? "redis://localhost:6379", {
      maxRetriesPerRequest: null, // required by BullMQ's blocking commands
    });
  }
  return shared;
}
