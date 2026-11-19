// Layout primitives for the Geo-grid monitor view: one card padding scale, one heading style,
// and a collapsible variant built on native <details>. No client state or effects.
import { useId, type ReactNode } from 'react';
import { ChevronDown, Info } from 'lucide-react';

const cardClass = 'rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900';

export function GridCard({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`${cardClass} p-5 ${className}`}>{children}</section>;
}

export function GridSectionTitle({ children, as: Tag = 'h3' }: { children: ReactNode; as?: 'h2' | 'h3' }) {
  return <Tag className="text-sm font-black text-slate-900 dark:text-white">{children}</Tag>;
}

/** Collapsible section. `meta` is a short muted note shown next to the title, visible while collapsed. */
export function GridCollapsible({ title, meta, defaultOpen = false, children }: {
  title: string;
  meta?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details className={`group/section ${cardClass}`} open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-2xl p-5 hover:bg-slate-50 dark:hover:bg-slate-800/50 [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 items-baseline gap-2">
          <GridSectionTitle>{title}</GridSectionTitle>
          {meta && <span className="truncate text-xs text-slate-500 dark:text-slate-400">{meta}</span>}
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-slate-400 transition-transform group-open/section:rotate-180" aria-hidden />
      </summary>
      <div className="border-t border-slate-100 p-5 dark:border-slate-800">{children}</div>
    </details>
  );
}

/**
 * Small info icon with a hover/focus tooltip. Focusable, so it also works on touch (tap to show).
 * `align="right"` opens the bubble leftwards, for icons near the right edge of a narrow screen.
 */
export function InfoTip({ text, label = 'What does this mean?', align = 'left' }: { text: string; label?: string; align?: 'left' | 'right' }) {
  const tipId = useId();
  return (
    <span className="group/tip relative inline-flex align-middle">
      <button
        type="button"
        aria-label={label}
        aria-describedby={tipId}
        className="inline-flex text-slate-400 transition-colors hover:text-slate-600 focus:text-slate-600 focus:outline-none dark:hover:text-slate-200 dark:focus:text-slate-200"
      >
        <Info className="h-3.5 w-3.5" aria-hidden />
      </button>
      <span
        id={tipId}
        role="tooltip"
        // display:none while hidden, so the bubble never widens the page at phone width.
        className={`pointer-events-none absolute top-full z-[1100] mt-1.5 hidden w-60 rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium normal-case leading-relaxed tracking-normal text-white shadow-lg group-hover/tip:block group-focus-within/tip:block dark:bg-slate-700 ${align === 'right' ? 'right-0' : 'left-0'}`}
      >
        {text}
      </span>
    </span>
  );
}
