import { useEffect, useState } from "react";
import { api } from "./api-client";

// No profile-picker UI exists yet (§7.1 multi-profile support is unbuilt on
// the frontend) — every view just operates as the account's first profile.
let cached: Promise<string | null> | null = null;

export function getPrimaryProfileId(): Promise<string | null> {
  if (!cached) {
    cached = api
      .GET("/profiles")
      .then(({ data }) => data?.[0]?.id ?? null)
      .catch(() => null);
  }
  return cached;
}

export function useProfileId(): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    getPrimaryProfileId().then(setId);
  }, []);
  return id;
}
