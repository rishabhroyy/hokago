import { RouterProvider, useRouter } from "./router";
import { SoundProvider } from "./ui/useWiiSound";
import { TopNav } from "./ui/TopNav";
import { HomeView } from "./views/HomeView";
import { LibraryView } from "./views/LibraryView";
import { DetailView } from "./views/DetailView";
import { LoginView } from "./views/LoginView";
import { NotFoundView } from "./views/NotFoundView";
import { WatchPage } from "./WatchPage";

function Routes() {
  const { route } = useRouter();
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
    case "notfound":
      return <NotFoundView />;
    default:
      return <HomeView />;
  }
}

export function App() {
  return (
    <SoundProvider>
      <RouterProvider>
        <TopNav />
        <Routes />
      </RouterProvider>
    </SoundProvider>
  );
}
