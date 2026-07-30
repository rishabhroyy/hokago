import logoMarkUrl from "./assets/logo.svg";

interface WordmarkProps {
  /** px, mark height — text scales to match. */
  size?: number;
  className?: string;
}

// The lockup: cat-ears mark (tinted via mask-image, the raw SVG's hardcoded
// fill is never used) + "hokago" set in Zen Maru Gothic 500, lowercase (§1).
// Placeholder mark/colors — superseded by the approved logo in the UI
// rebuild's icon/logo step (docs/ui-handoff).
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
          backgroundColor: "#E8664F",
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
          color: "#35302B",
        }}
      >
        hokago
      </span>
    </span>
  );
}
