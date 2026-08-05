import { useCallback, useEffect, useRef, useState } from "react";
import { paths, useRouter } from "../router";
import { Icon, type IconName } from "../ui/icons";
import { LogoMark } from "../ui/Logo";
import { useIsAdmin } from "../profile";
import { DashboardPage } from "./DashboardPage";
import { LibrariesPage } from "./LibrariesPage";
import { UsersPage } from "./UsersPage";
import { InvitesPage } from "./InvitesPage";
import { SessionsPage } from "./SessionsPage";
import { JobsPage } from "./JobsPage";
import { SettingsPage } from "./SettingsPage";

type Page = "dashboard" | "libraries" | "users" | "invites" | "sessions" | "jobs" | "settings";

const PAGES: Record<Page, { title: string; sub: string; icon: IconName }> = {
  dashboard: { title: "Dashboard", sub: "server overview", icon: "grid" },
  libraries: { title: "Libraries", sub: "media roots, storage and scan control", icon: "lib" },
  users: { title: "Users", sub: "accounts and access control", icon: "users" },
  invites: { title: "Invites", sub: "invite codes for new accounts", icon: "ticket" },
  sessions: { title: "Sessions", sub: "active login sessions", icon: "monitor" },
  jobs: { title: "Jobs", sub: "worker queues and retries", icon: "activity" },
  settings: { title: "Settings", sub: "server config and metadata providers", icon: "gear" },
};

export function AdminView() {
  const { navigate } = useRouter();
  const isAdmin = useIsAdmin();
  const [page, setPage] = useState<Page>("dashboard");
  const [toasts, setToasts] = useState<{ msg: string; err?: boolean; id: number }[]>([]);
  const toastId = useRef(0);

  const toast = useCallback((msg: string, err?: boolean) => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { msg, err, id }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
  }, []);

  const meta = PAGES[page];

  if (!isAdmin) {
    return (
      <div className="flex min-h-screen items-center justify-center px-6">
        <div className="panel flex max-w-[440px] flex-col items-center rounded-[32px] p-12 text-center">
          <span className="mb-6 flex h-24 w-24 items-center justify-center rounded-[28px] bg-[linear-gradient(135deg,#45ADDD,#187AA5)] text-white shadow-btn-blue">
            <LogoMark className="h-12 w-12" />
          </span>
          <h1 className="mb-2 font-display text-title font-bold">admins only</h1>
          <p className="mb-8 text-body leading-relaxed text-ink-2">this page needs an admin account — sign in as one to manage the server.</p>
          <button className="btn btn-primary" onClick={() => navigate(paths.home())}>back to hokago</button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-[1400px] gap-6 px-6 py-6 max-[860px]:px-3 max-[860px]:py-3">
      <aside className="panel sticky top-6 flex h-[calc(100vh-48px)] w-[236px] shrink-0 flex-col rounded-[26px] p-3.5 max-[860px]:top-3 max-[860px]:h-[calc(100vh-24px)] max-[860px]:w-[64px]">
        <button
          className="mb-5 flex items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition-transform duration-150 ease-snap hover:scale-[1.04] active:scale-[.94]"
          onClick={() => navigate(paths.home())}
          title="back to hokago"
        >
          <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-[linear-gradient(160deg,#8FE0F5,#2E9BC4)] text-white shadow-[inset_0_1.5px_0_rgba(255,255,255,0.5),0_4px_10px_-4px_rgba(46,155,196,0.6)]">
            <LogoMark className="h-[22px] w-[22px]" />
          </span>
          <span className="font-display text-[17px] font-bold text-ink max-[860px]:hidden">hokago</span>
          <span className="rounded-full bg-wii/15 px-2 py-[3px] font-mono text-kicker font-bold uppercase tracking-[0.1em] text-wii-deep max-[860px]:hidden">admin</span>
        </button>

        <nav className="flex flex-col gap-1">
          {(Object.keys(PAGES) as Page[]).map((p) => (
            <button
              key={p}
              className={`flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-meta font-semibold transition ${
                p === page ? "bg-wii/15 font-bold text-wii-deep" : "text-ink-2 hover:bg-paper-2/60 hover:text-ink dark:hover:bg-paper-2/25"
              } max-[860px]:justify-center max-[860px]:px-0`}
              onClick={() => setPage(p)}
              title={PAGES[p].title}
            >
              <Icon name={PAGES[p].icon} className="h-[16px] w-[16px] shrink-0" />
              <span className="max-[860px]:hidden">{PAGES[p].title}</span>
            </button>
          ))}
        </nav>

        <div className="mt-auto border-t border-line pt-2.5">
          <button
            className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-small font-semibold text-ink-3 transition hover:bg-paper-2/60 hover:text-ink max-[860px]:justify-center max-[860px]:px-0 dark:hover:bg-paper-2/25"
            onClick={() => navigate(paths.home())}
          >
            <Icon name="back" className="h-[14px] w-[14px] shrink-0" />
            <span className="max-[860px]:hidden">back to hokago</span>
          </button>
        </div>
      </aside>

      <main className="min-w-0 flex-1 pb-16">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-title font-bold text-ink">{meta.title}</h1>
            <p className="text-meta font-semibold text-ink-2">{meta.sub}</p>
          </div>
          {page === "jobs" && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-3 py-1 font-mono text-kicker font-bold uppercase tracking-[0.1em] text-emerald-600 dark:text-emerald-400">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" /> live · 5s
            </span>
          )}
        </header>

        {page === "dashboard" && <DashboardPage />}
        {page === "libraries" && <LibrariesPage toast={toast} />}
        {page === "users" && <UsersPage toast={toast} />}
        {page === "invites" && <InvitesPage toast={toast} />}
        {page === "sessions" && <SessionsPage toast={toast} />}
        {page === "jobs" && <JobsPage toast={toast} />}
        {page === "settings" && <SettingsPage toast={toast} />}
      </main>

      <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex flex-col items-center gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto rounded-full border px-5 py-2.5 text-meta font-bold shadow-panel backdrop-blur ${
              t.err
                ? "border-red-500/40 bg-red-500/90 text-white"
                : "border-line bg-card/95 text-ink dark:bg-paper/95"
            }`}
          >
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}