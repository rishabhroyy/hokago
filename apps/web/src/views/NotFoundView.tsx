import { paths, useRouter } from "../router";
import { Icon } from "../ui/icons";

export function NotFoundView() {
  const { navigate } = useRouter();
  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="panel flex max-w-[420px] flex-col items-center rounded-[32px] p-12 text-center">
        <span className="mb-6 flex h-20 w-20 items-center justify-center rounded-[24px] bg-gradient-to-br from-wii-2/50 to-wii/40 text-wii-deep">
          <Icon name="cloudsun" className="h-10 w-10" />
        </span>
        <h1 className="mb-2 font-display text-[24px] font-bold">channel not found</h1>
        <p className="mb-7 text-[13.5px] text-ink-2">this page drifted off the menu.</p>
        <button className="btn btn-primary" onClick={() => navigate(paths.home())}>
          <Icon name="back" className="h-4 w-4" />
          Back home
        </button>
      </div>
    </div>
  );
}
