// Shared admin console primitives — warm KyoAni design language, same tokens
// as the rest of the PWA (panel, wii, ink) so /admin feels native.
import type { ReactNode } from "react";
import { Icon, type IconName } from "../ui/icons";

export type Toast = { msg: string; err?: boolean; id: number };

export function Badge({ tone, children }: { tone: "green" | "blue" | "gold" | "red" | "gray"; children: ReactNode }) {
  const cls = {
    green: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    blue: "bg-sky-500/15 text-sky-700 dark:text-sky-400",
    gold: "bg-amber-500/20 text-amber-700 dark:text-amber-400",
    red: "bg-red-500/15 text-red-600 dark:text-red-400",
    gray: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400",
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-[3px] text-kicker font-bold uppercase tracking-[0.06em] ${cls}`}>
      {children}
    </span>
  );
}

export function Card({ head, hint, right, children }: { head: ReactNode; hint?: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-5 rounded-panel border border-line bg-card p-5 shadow-panel">
      {(head || hint || right) && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {head && <h2 className="font-display text-card-head font-bold text-ink">{head}</h2>}
          {hint && <span className="ml-auto text-small font-semibold text-ink-3">{hint}</span>}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ icon, tone, value, label, sub }: { icon: IconName; tone?: "green" | "gold" | "red"; value: string; label: string; sub?: ReactNode }) {
  const chip = {
    green: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    gold: "bg-amber-500/20 text-amber-600 dark:text-amber-400",
    red: "bg-red-500/15 text-red-500 dark:text-red-400",
  }[tone ?? "green"];
  return (
    <div className="flex items-center gap-3.5 rounded-[18px] border border-line bg-card p-4 shadow-panel">
      <span className={`flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl ${chip}`}>
        <Icon name={icon} className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <div className="text-section font-extrabold leading-tight tabular-nums text-ink">{value}</div>
        <div className="font-mono text-kicker font-bold uppercase tracking-[0.1em] text-ink-3">{label}</div>
        {sub && <div className="truncate text-small font-semibold text-ink-2">{sub}</div>}
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl bg-paper-2/50 px-4 py-6 text-center text-meta font-semibold text-ink-3 dark:bg-paper-2/20">{children}</div>;
}

export const inputCls =
  "w-full rounded-[10px] border border-line bg-paper-2/50 px-3 py-2 text-meta font-semibold text-ink outline-none transition placeholder:text-ink-3 focus:border-wii focus:shadow-[0_0_0_3px_rgba(79,184,224,0.25)] dark:bg-paper-2/30";

export const btnCls =
  "inline-flex items-center gap-1.5 rounded-[10px] border border-line bg-card px-3 py-1.5 text-small font-bold text-ink-2 shadow-[0_1px_2px_rgba(60,40,25,0.05)] transition hover:border-wii/50 hover:text-wii-deep hover:shadow-[0_0_0_3px_rgba(79,184,224,0.15)] active:scale-95";

export const dangerCls =
  "inline-flex items-center gap-1.5 rounded-[10px] border border-accent/35 bg-card px-3 py-1.5 text-small font-bold text-accent transition hover:bg-accent hover:text-white active:scale-95";

export function ActionBtn({ icon, children, onClick, danger }: { icon?: IconName; children: ReactNode; onClick?: () => void; danger?: boolean }) {
  return (
    <button type="button" className={danger ? dangerCls : btnCls} onClick={onClick}>
      {icon && <Icon name={icon} className="h-[13px] w-[13px]" />}
      {children}
    </button>
  );
}

export function PrimaryBtn({ icon, children, onClick }: { icon?: IconName; children: ReactNode; onClick?: () => void }) {
  return (
    <button type="button" className="btn-primary px-5 py-2.5 text-meta" onClick={onClick}>
      {icon && <Icon name={icon} className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5">
      <span className="font-mono text-kicker font-bold uppercase tracking-[0.1em] text-ink-3">{label}</span>
      {children}
    </label>
  );
}

export function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-small font-bold text-ink-2">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-[#45ADDD]" />
      {children}
    </label>
  );
}

export function Table({ headers, children }: { headers: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-meta">
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h} className="whitespace-nowrap px-3 pb-2.5 font-mono text-kicker font-bold uppercase tracking-[0.1em] text-ink-3 first:pl-1 last:pr-1">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Td({ className = "", title, children }: { className?: string; title?: string; children: ReactNode }) {
  return <td className={`border-t border-line px-3 py-2.5 align-middle first:pl-1 last:pr-1 ${className}`} title={title}>{children}</td>;
}