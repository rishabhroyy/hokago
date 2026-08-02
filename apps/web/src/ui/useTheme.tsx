import { useCallback, useEffect, useState } from "react";
import { Icon } from "./icons";
import { useWiiSound } from "./useWiiSound";

const STORAGE_KEY = "hokago_theme";

/**
 * Light/dark theme. The `.dark` class on <html> is the source of truth (set
 * before first paint by the inline script in index.html, so there's no flash).
 * The user's explicit choice is stored; until they pick, the OS preference is
 * followed live.
 */
export function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  );

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  // Until the user picks a side, track the OS preference.
  useEffect(() => {
    if (localStorage.getItem(STORAGE_KEY)) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setTheme(e.matches ? "dark" : "light");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const toggle = useCallback(
    () => setTheme((t) => (t === "dark" ? "light" : "dark")),
    [],
  );

  return { theme, toggle };
}

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const s = useWiiSound();
  return (
    <button
      className="icobtn flex h-[38px] w-[38px] items-center justify-center rounded-full transition-all duration-150 ease-snap hover:bg-wii/10 hover:text-wii-deep active:scale-90"
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      onClick={() => {
        s.select();
        toggle();
      }}
    >
      <Icon name={theme === "dark" ? "sun" : "moon"} className="h-[17px] w-[17px]" />
    </button>
  );
}
