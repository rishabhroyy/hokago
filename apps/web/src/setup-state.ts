export interface SetupState {
  setupRequired: boolean;
}

// Default: pretend setup is done until the boot fetch proves otherwise — the
// login gate must not flash the wizard on an API hiccup.
let cached: SetupState = { setupRequired: false };

/** One-shot boot probe; main.tsx awaits it before rendering (mirrors fetchFonts). */
export async function fetchSetupState(): Promise<SetupState> {
  try {
    const res = await fetch("/setup/state", { headers: { Accept: "application/json" } });
    if (!res.ok) return cached;
    const data = (await res.json()) as SetupState;
    cached = {
      setupRequired: Boolean(data.setupRequired),
    };
  } catch {
    // API unreachable (containers down in dev) — fall through to the default
    // so the app still boots to the login gate instead of a dead wizard.
  }
  return cached;
}

export function getSetupState(): SetupState {
  return cached;
}