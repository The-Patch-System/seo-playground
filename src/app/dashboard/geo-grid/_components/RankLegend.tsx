import { RANK_COLORS } from '@/lib/grid-locations';

const ITEMS = [
  { label: '1-3', color: RANK_COLORS.top3 },
  { label: '4-10', color: RANK_COLORS.top10 },
  { label: '11-20', color: RANK_COLORS.top20 },
  { label: '20+ or no data', color: RANK_COLORS.out },
];

export default function RankLegend() {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-semibold text-slate-600" aria-label="Rank colors">
      {ITEMS.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          <i className="h-3 w-3 rounded-[3px]" style={{ background: item.color }} aria-hidden="true" />
          {item.label}
        </li>
      ))}
    </ul>
  );
}
