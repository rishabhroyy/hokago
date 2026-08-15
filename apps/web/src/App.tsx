import { RouterProvider, useRouter, type Route } from "./router";
import { SoundProvider } from "./ui/useWiiSound";
import { TopNav } from "./ui/TopNav";
import { useTvKeyboardNav } from "./ui/tv-keys";
import { HomeView } from "./views/HomeView";
import { LibraryView } from "./views/LibraryView";
import { DetailView } from "./views/DetailView";
import { LoginView } from "./views/LoginView";
import { SetupView } from "./views/SetupView";
import { PrefsView } from "./views/PrefsView";
import { PairView } from "./views/PairView";
import { SearchView } from "./views/SearchView";
import { PartyView } from "./views/PartyView";
import { NotFoundView } from "./views/NotFoundView";
import { TvAccountsView } from "./views/TvAccountsView";
import { DownloadsView } from "./views/DownloadsView";
import { NativeUpdateGate } from "./views/NativeUpdateGate";
import { WatchPage } from "./WatchPage";
import { AdminView } from "./admin/AdminView";
import { getSetupState } from "./setup-state";
import { isTvShell } from "./native";
import { getActiveAccount, hasActiveAccount } from "./tv-session";

function Shell() {
  const { route } = useRouter();
  // Native shell update gate: the SPA always comes from the server, but a
  // shell older than the web's MIN_NATIVE_VERSION is gated here. Renders its
  // children unchanged when the shell is current (or there's no shell at all).
  // Never gate the setup/login screens — those must always be reachable.
  if (route.view === "setup" || route.view === "login") return <ShellRoutes route={route} />;
  return (
    <NativeUpdateGate>
      <ShellRoutes route={route} />
    </NativeUpdateGate>
  );
}

function ShellRoutes({ route }: { route: Route }) {
  // Admin is a full-screen console with its own sidebar — no top pill nav.
  if (route.view === "admin") return <AdminView />;
  // Fresh install with no accounts: /login is a dead end (register needs an
  // invite, invites need an admin) — bounce it to the first-run wizard.
  if (route.view === "login") return getSetupState().setupRequired ? <SetupView /> : <LoginView />;
  if (route.view === "setup") return getSetupState().setupRequired ? <SetupView /> : <HomeView />;
  // Fresh install — no accounts yet, so register/invite/login is a dead end
  // (register needs an invite, invites need an admin). Route everywhere to
  // the first-run wizard until the first admin account exists.
  if (getSetupState().setupRequired) return <SetupView />;

  // ── TV shell: never a username/password login — pairing only, and the
  // account switcher replaces the login gate entirely.
  if (isTvShell()) {
    if (!hasActiveAccount()) return <TvAccountsView />;
    if (route.view === "accounts") return <TvAccountsView />;
  }

  // Anonymous session — don't render views that will just 401 into a blank page.
  if (!localStorage.getItem("hokago_access_token") && !getActiveAccount()) return <LoginView />;
  switch (route.view) {
    case "library":
      return <LibraryView libraryId={route.libraryId} />;
    case "detail":
      return <DetailView itemId={route.itemId} />;
    case "player":
      return <WatchPage mediaFileId={route.mediaFileId} />;
    case "prefs":
      return <PrefsView />;
    case "pair":
      return <PairView />;
    case "accounts":
      return <TvAccountsView />;
    case "downloads":
      return <DownloadsView />;
    case "search":
      return <SearchView initialQuery={route.q} />;
    case "party":
      return <PartyView code={route.code} />;
    case "notfound":
      return <NotFoundView />;
    default:
      return <HomeView />;
  }
}

function Chrome() {
  const { route } = useRouter();
  useTvKeyboardNav();
  return (
    <>
      {route.view !== "admin" && <TopNav />}
      <Shell />
    </>
  );
}

export function App() {
  return (
    <SoundProvider>
      <RouterProvider>
        <Chrome />
      </RouterProvider>
    </SoundProvider>
  );
}