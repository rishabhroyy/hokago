import { RouterProvider, useRouter } from "./router";
import { SoundProvider } from "./ui/useWiiSound";
import { TopNav } from "./ui/TopNav";
import { HomeView } from "./views/HomeView";
import { LibraryView } from "./views/LibraryView";
import { DetailView } from "./views/DetailView";
import { WatchPage } from "./WatchPage";

function Routes() {
  const { route } = useRouter();
  switch (route.view) {
    case "library":
      return <LibraryView libraryId={route.libraryId} />;
    case "detail":
      return <DetailView itemId={route.itemId} />;
    case "player":
      return <WatchPage mediaFileId={route.mediaFileId} />;
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
