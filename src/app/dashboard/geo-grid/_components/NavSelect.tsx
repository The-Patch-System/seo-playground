'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

export interface NavOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/** A select that navigates to `buildHref(value)` on change. Works as a plain GET form without JS. */
export default function NavSelect({
  id, label, name, value, options, baseHref, extraParams = {},
}: {
  id: string;
  label: string;
  name: string;
  value: string;
  options: NavOption[];
  baseHref: string;
  /** Other query params to keep. */
  extraParams?: Record<string, string>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const hrefFor = (next: string) => {
    const params = new URLSearchParams(extraParams);
    if (next) params.set(name, next); else params.delete(name);
    const query = params.toString();
    return query ? `${baseHref}?${query}` : baseHref;
  };
  return (
    <form action={baseHref} method="get" className="flex flex-wrap items-center gap-2">
      {Object.entries(extraParams).map(([key, val]) => <input key={key} type="hidden" name={key} value={val} />)}
      <label htmlFor={id} className="text-xs font-semibold text-slate-600">{label}</label>
      <select
        id={id}
        name={name}
        defaultValue={value}
        aria-busy={pending}
        onChange={(event) => {
          const next = event.target.value;
          startTransition(() => router.push(hrefFor(next), { scroll: false }));
        }}
        className="min-h-9 rounded-[10px] border border-slate-300 bg-white px-2.5 text-[13px] font-semibold text-slate-900"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>
        ))}
      </select>
      <noscript><button type="submit" className="min-h-9 rounded-[10px] border border-slate-300 px-2.5 text-xs font-bold">Show</button></noscript>
    </form>
  );
}
