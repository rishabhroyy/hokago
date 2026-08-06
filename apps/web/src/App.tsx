import { useEffect } from "react";
import { RouterProvider, useRouter } from "./router";
import { SoundProvider } from "./ui/useWiiSound";
import { TopNav } from "./ui/TopNav";
import { HomeView } from "./views/HomeView";
import { LibraryView } from "./views/LibraryView";
import { DetailView } from "./views/DetailView";
import { LoginView } from "./views/LoginView";
import { PrefsView } from "./views/PrefsView";
import { NotFoundView } from "./views/NotFoundView";
import { WatchPage } from "./WatchPage";
import { AdminView } from "./admin/AdminView";

/**
 * The living-room lamp glow (body::after) lazily trails the pointer. The
 * glow is the one reactive element of the wallpaper — it drifts ±5% toward
 * where your cursor sits, easing on an exponential decay, and the rAF loop
 * stops as soon as it settles so an idle page costs nothing. Reduced-motion
 * users get a static lamp (the CSS keeps --glow-x/y at 0%).
 */
function useLampTrail() {
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const body = document.body;
    let targetX = 0;
    let targetY = 0;
    let curX = 0;
    let curY = 0;
    let raf = 0;
    let last = 0;
    const loop = (now: number) => {
      const dt = Math.min(now - last || 16, 100);
      last = now;
      const k = 1 - Math.exp(-dt / 700);
      curX += (targetX - curX) * k;
      curY += (targetY - curY) * k;
      body.style.setProperty("--glow-x", `${(curX * 6).toFixed(2)}%`);
      body.style.setProperty("--glow-y", `${(curY * 6).toFixed(2)}%`);
      if (Math.abs(targetX - curX) > 0.002 || Math.abs(targetY - curY) > 0.002) {
        raf = requestAnimationFrame(loop);
      } else {
        raf = 0;
      }
    };
    const onMove = (e: PointerEvent) => {
      targetX = e.clientX / window.innerWidth - 0.5;
      targetY = e.clientY / window.innerHeight - 0.5;
      if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(loop);
      }
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
}

function Shell() {
  const { route } = useRouter();
  // Admin is a full-screen console with its own sidebar — no top pill nav.
  if (route.view === "admin") return <AdminView />;
  if (route.view === "login") return <LoginView />;
  // Anonymous session — don't render views that will just 401 into a blank page.
  if (!localStorage.getItem("hokago_access_token")) return <LoginView />;
  switch (route.view) {
    case "library":
      return <LibraryView libraryId={route.libraryId} />;
    case "detail":
      return <DetailView itemId={route.itemId} />;
    case "player":
      return <WatchPage mediaFileId={route.mediaFileId} />;
    case "prefs":
      return <PrefsView />;
    case "notfound":
      return <NotFoundView />;
    default:
      return <HomeView />;
  }
}

function Chrome() {
  const { route } = useRouter();
  return (
    <>
      {route.view !== "admin" && <TopNav />}
      <Shell />
    </>
  );
}

export function App() {
  useLampTrail();
  return (
    <SoundProvider>
      <RouterProvider>
        <Chrome />
      </RouterProvider>
    </SoundProvider>
  );
}