import { Icon } from "./icons";

// [left %, top %, size px, delay s] — scattered over the whole screen, a little denser in the glows
const SPARKLES: [number, number, number, number][] = [
  [88, 8, 18, 0],
  [76, 18, 11, 1.8],
  [94, 32, 14, 3.1],
  [62, 6, 9, 4.4],
  [6, 12, 14, 0.9],
  [18, 4, 9, 2.6],
  [3, 36, 11, 5.2],
  [40, 22, 8, 6.4],
  [52, 46, 10, 3.7],
  [30, 58, 12, 0.4],
  [72, 54, 9, 2.2],
  [96, 66, 13, 4.9],
  [12, 74, 11, 1.3],
  [44, 82, 9, 5.8],
  [82, 88, 15, 2.9],
  [24, 94, 10, 4.1],
  [62, 96, 12, 6.8],
];

/**
 * Fixed scenery over the body gradient: the Wii Menu dot grid, manga
 * screentone shading in two corners, and a few slow anime twinkles.
 */
export function Backdrop() {
  return (
    <div aria-hidden className="backdrop">
      <div className="backdrop-grid" />
      <div className="backdrop-tone" />
      {SPARKLES.map(([x, y, size, delay], i) => (
        <Icon
          key={i}
          name="sparkle"
          className="backdrop-sparkle"
          style={{ left: `${x}%`, top: `${y}%`, width: size, height: size, animationDelay: `${delay}s` }}
        />
      ))}
    </div>
  );
}
