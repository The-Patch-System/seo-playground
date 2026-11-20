'use client';

import { useRouter } from 'next/navigation';
import { useTransition } from 'react';

/** A select whose option values are URLs; picking one navigates there (e.g. switching keyword). */
export default function HrefSelect({ id, label, value, options, className = '' }: {
  id: string;
  /** Screen-reader label. */
  label: string;
  value: string;
  options: Array<{ href: string; label: string }>;
  className?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <>
      <label htmlFor={id} className="sr-only">{label}</label>
      <select
        id={id}
        defaultValue={value}
        aria-busy={pending}
        onChange={(event) => {
          const href = event.target.value;
          startTransition(() => router.push(href));
        }}
        className={className}
      >
        {options.map((option) => <option key={option.href} value={option.href}>{option.label}</option>)}
      </select>
    </>
  );
}
