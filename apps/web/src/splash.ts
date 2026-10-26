// Boot splash (markup + styles inline in index.html). The app renders under
// it; whoever owns the first screen calls hideSplash() once that screen is
// whole, and the fade waits for the webfonts that render kicked off — so the
// reveal is one finished page, not text reflowing and posters popping in.

// ponytail: hard cap so a hung fetch never strands the user on the splash
const MAX_MS = 6000;
let hidden = false;
let held = false;

/** A view that will call hideSplash() itself claims the splash in its mount effect. */
export function holdSplash(): void {
  held = true;
}

/** App-level fallback, run after child effects: reveal now unless a view claimed it. */
export function hideSplashUnlessHeld(): void {
  if (!held) hideSplash();
}

export function hideSplash(): void {
  if (hidden) return;
  hidden = true;
  const el = document.getElementById("hk-splash");
  if (!el) return;
  void document.fonts.ready.then(() => {
    el.classList.add("hk-out");
    setTimeout(() => el.remove(), 500);
  });
}

setTimeout(hideSplash, MAX_MS);

/** Resolve once `src` is decoded, failed, or 2.5s passed — never rejects. */
export function preloadImage(src: string | null | undefined): Promise<void> {
  if (!src) return Promise.resolve();
  const img = new Image();
  img.src = src;
  return Promise.race([img.decode().catch(() => undefined), new Promise<void>((r) => setTimeout(r, 2500))]);
}
