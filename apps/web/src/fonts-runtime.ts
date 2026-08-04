export const FONTS_STYLE_TAG_ID = "hk-fonts";

export interface FontDescriptor {
  hash: string;
  family: string;
  weight: number | null;
  style: string | null;
  url: string;
}

/**
 * Fonts are served from our own origin, byte-for-byte, via the same
 * hash-addressed store subtitle fonts use — never a
 * third-party @import or <link>. Missing/failed fonts just fall through to
 * the CSS font stack's next member; nothing here can break the page .
 */
export function applyFonts(fonts: FontDescriptor[]): void {
  const style = document.getElementById(FONTS_STYLE_TAG_ID) as HTMLStyleElement | null;
  if (!style) return;
  style.textContent = fonts
    .map(
      (f) =>
        `@font-face { font-family: "${f.family}"; font-weight: ${f.weight ?? 400}; font-style: ${f.style ?? "normal"}; src: url("${f.url}") format("woff2"); font-display: swap; }`,
    )
    .join("\n");
}

export async function fetchFonts(): Promise<FontDescriptor[]> {
  const res = await fetch("/fonts");
  if (!res.ok) return [];
  return res.json();
}
