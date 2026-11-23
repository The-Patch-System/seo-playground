'use client';

import { useActionState, useEffect, useRef, useState, useTransition, type FormEvent, type ReactNode } from 'react';
import { X } from 'lucide-react';

export const BTN_PRIMARY = 'inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl bg-blue-600 px-3.5 text-[13px] font-bold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60';
export const BTN_SECONDARY = 'inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3.5 text-[13px] font-bold text-slate-800 hover:border-slate-400 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800';
export const BTN_DANGER = 'inline-flex min-h-10 items-center justify-center gap-1.5 rounded-xl bg-red-600 px-3.5 text-[13px] font-bold text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-60';
export const INPUT = 'min-h-10 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100';
export const LABEL = 'mb-1 block text-xs font-bold text-slate-700 dark:text-slate-300';

/** A button that opens a modal dialog. `children` gets a close callback. */
export default function Modal({ trigger, triggerClassName = BTN_SECONDARY, title, wide = false, children }: {
  trigger: ReactNode;
  triggerClassName?: string;
  title: string;
  wide?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <>
      <button type="button" className={triggerClassName} onClick={() => setOpen(true)}>{trigger}</button>
      <dialog
        ref={ref}
        onClose={() => setOpen(false)}
        onClick={(event) => { if (event.target === ref.current) setOpen(false); }}
        className={`m-auto w-[calc(100vw-2rem)] ${wide ? 'max-w-2xl' : 'max-w-md'} rounded-2xl border border-slate-200 bg-white p-0 text-slate-900 shadow-xl backdrop:bg-slate-900/40 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100`}
      >
        {open && (
          <div className="flex flex-col gap-4 p-5">
            <div className="flex items-start justify-between gap-3">
              <h2 className="text-lg font-black tracking-tight">{title}</h2>
              <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="rounded-lg p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800">
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
            {children(() => setOpen(false))}
          </div>
        )}
      </dialog>
    </>
  );
}

export function FormMessage({ state }: { state: { error?: string; message?: string } }) {
  if (state.error) return <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">{state.error}</p>;
  if (state.message) return <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">{state.message}</p>;
  return null;
}

/**
 * useActionState, but submitted from onSubmit so React doesn't reset the form afterwards: a refused
 * save (duplicate domain, wrong confirmation) keeps what was typed.
 */
export function useKeepFormAction<S>(action: (state: Awaited<S>, formData: FormData) => S | Promise<S>, initial: Awaited<S>) {
  const [state, dispatch, pending] = useActionState(action, initial);
  const [, startTransition] = useTransition();
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => dispatch(formData));
  };
  return [state, onSubmit, pending] as const;
}
