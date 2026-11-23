'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';

/**
 * The keyword page title, which doubles as a menu of the location's other keywords.
 * The keyword stays the page's big heading; a chevron chip and hover state show it opens.
 */
export default function KeywordSwitcher({ current, heading, options }: {
  current: string;
  /** Menu caption, e.g. "Keywords at Location 1". */
  heading: string;
  options: Array<{ href: string; label: string; current: boolean }>;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); buttonRef.current?.focus(); }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative max-w-full">
      <h1 className="text-[26px] font-black tracking-tight">
        <button
          ref={buttonRef}
          type="button"
          aria-haspopup="true"
          aria-expanded={open}
          aria-controls={menuId}
          title="Switch keyword"
          onClick={() => setOpen((v) => !v)}
          className="group -mx-2 flex items-center gap-2.5 rounded-xl px-2 py-0.5 text-left text-slate-900 hover:bg-slate-100 aria-expanded:bg-slate-100 dark:text-white dark:hover:bg-slate-800 dark:aria-expanded:bg-slate-800"
        >
          <span className="break-words">{current}</span>
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-600 group-hover:border-slate-400 group-hover:text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-300">
            <ChevronDown aria-hidden="true" className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} strokeWidth={2.5} />
          </span>
          <span className="sr-only">Switch keyword</span>
        </button>
      </h1>
      {open && (
        <div
          id={menuId}
          className="absolute left-0 top-full z-50 mt-1.5 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900"
        >
          <p className="px-3 pb-1 pt-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-500">{heading}</p>
          <ul>
            {options.map((option) => (
              <li key={option.href}>
                <Link
                  href={option.href}
                  aria-current={option.current ? 'page' : undefined}
                  onClick={() => setOpen(false)}
                  className={`flex items-center gap-2 px-3 py-2 text-sm font-semibold hover:bg-slate-50 dark:hover:bg-slate-800 ${option.current ? 'text-blue-700 dark:text-blue-300' : 'text-slate-800 dark:text-slate-200'}`}
                >
                  <Check aria-hidden="true" className={`h-4 w-4 shrink-0 ${option.current ? '' : 'invisible'}`} strokeWidth={2.5} />
                  <span className="truncate">{option.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
