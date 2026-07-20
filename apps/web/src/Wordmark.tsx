import logoMarkUrl from "../../../packages/theme/assets/logo.svg";

interface WordmarkProps {
  /** px, mark height — text scales to match. */
  size?: number;
  className?: string;
}

// The lockup: cat-ears mark (tinted via mask-image, §15.1 — the raw SVG's
// hardcoded fill is never used) + "hokago" set in Zen Maru Gothic 500,
// lowercase (§1). This is the one deliberate exception to "tokens only for
// fonts" — the wordmark face is fixed brand identity, not a theme choice,
// same reason font.wordmark stays theme-swappable for everything else.
export function Wordmark({ size = 28, className }: WordmarkProps) {
  return (
    <span
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: size * 0.32,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: "inline-block",
          width: size,
          height: size,
          backgroundColor: "var(--hk-color-accent)",
          maskImage: `url(${logoMarkUrl})`,
          maskRepeat: "no-repeat",
          maskSize: "contain",
          maskPosition: "center",
          WebkitMaskImage: `url(${logoMarkUrl})`,
          WebkitMaskRepeat: "no-repeat",
          WebkitMaskSize: "contain",
          WebkitMaskPosition: "center",
        }}
      />
      <span
        style={{
          fontFamily: '"Zen Maru Gothic"',
          fontWeight: 500,
          fontSize: size * 0.86,
          lineHeight: 1,
          color: "var(--hk-color-text)",
        }}
      >
        hokago
      </span>
    </span>
  );
}
