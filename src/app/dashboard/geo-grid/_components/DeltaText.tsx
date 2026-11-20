import type { Delta } from '@/lib/grid-locations';

const TONE: Record<Delta['tone'], string> = {
  better: 'text-emerald-700 dark:text-emerald-400',
  worse: 'text-red-700 dark:text-red-400',
  same: 'text-slate-500',
  none: 'text-slate-500',
};

/** "▲ 3" / "▼ 0.4 worse" in green or red; `fallback` when there's nothing to compare. */
export default function DeltaText({ delta, fallback = '', className = '' }: { delta: Delta; fallback?: string; className?: string }) {
  const text = delta.tone === 'none' ? fallback : delta.label;
  if (!text) return null;
  return <span className={`font-bold whitespace-nowrap ${TONE[delta.tone]} ${className}`}>{text}</span>;
}
