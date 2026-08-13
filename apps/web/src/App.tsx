import { RouterProvider, useRouter } from "./router";
import { SoundProvider } from "./ui/useWiiSound";
import { TopNav } from "./ui/TopNav";
import { HomeView } from "./views/HomeView";
import { LibraryView } from "./views/LibraryView";
import { DetailView } from "./views/DetailView";
import { LoginView } from "./views/LoginView";
import { PrefsView } from "./views/PrefsView";
import { PairView } from "./views/PairView";
import { SearchView } from "./views/SearchView";
import { PartyView } from "./views/PartyView";
import { NotFoundView } from "./views/NotFoundView";
import { WatchPage } from "./WatchPage";
import { AdminView } from "./admin/AdminView";

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
    case "pair":
      return <PairView />;
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