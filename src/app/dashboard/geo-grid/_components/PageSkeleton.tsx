/** Placeholder shown by each Geo-grid loading.tsx while the next page renders, so a click responds at once. */
export default function PageSkeleton({ variant }: { variant: 'table' | 'cards' | 'keyword' }) {
  const bar = 'animate-pulse rounded-lg bg-slate-200 dark:bg-slate-800';
  const panel = 'animate-pulse rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900';
  return (
    <div className="flex flex-col gap-4" role="status" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <div className="flex flex-col gap-2">
        <div className={`${bar} h-4 w-56`} />
        <div className={`${bar} h-8 w-72`} />
        <div className={`${bar} h-4 w-96 max-w-full`} />
      </div>
      {variant === 'table' && <div className={`${panel} h-96`} />}
      {variant === 'cards' && (
        <div className="grid gap-4 md:grid-cols-2">
          {[0, 1, 2, 3].map((i) => <div key={i} className={`${panel} h-56`} />)}
        </div>
      )}
      {variant === 'keyword' && (
        <>
          <div className="grid grid-cols-5 gap-3">
            {[0, 1, 2, 3, 4].map((i) => <div key={i} className={`${panel} h-24`} />)}
          </div>
          <div className={`${panel} h-[480px]`} />
        </>
      )}
    </div>
  );
}
