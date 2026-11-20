import type { GridPoint } from '@/lib/db';
import { rankColor, rankLabel } from '@/lib/grid-locations';

/**
 * A small heatmap of one scan, at the keyword's real grid size. Gray = outside the top 20 or no data.
 * Hovering a square shows its rank. The card around it carries the numbers for screen readers.
 */
export default function MiniGrid({ points, gridSize, label }: { points: GridPoint[]; gridSize: number; label: string }) {
  const byCell = new Map(points.map((p) => [`${p.row}:${p.col}`, p]));
  const cells = [];
  for (let row = 0; row < gridSize; row += 1) {
    for (let col = 0; col < gridSize; col += 1) {
      const point = byCell.get(`${row}:${col}`);
      const text = rankLabel(point);
      const tip = text === '—' ? 'No data' : text === '20+' ? 'Not in top 20' : `Rank ${text}`;
      // Tooltip opens downward on the top rows so it isn't clipped.
      const below = row < 2;
      cells.push(
        <span key={`${row}:${col}`} className="group relative block aspect-square rounded-[3px] hover:ring-2 hover:ring-slate-900 dark:hover:ring-white" style={{ background: rankColor(point) }}>
          <span
            aria-hidden="true"
            className={`pointer-events-none absolute left-1/2 z-10 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-900 px-2 py-1 text-[11px] font-bold text-white shadow-lg group-hover:block ${below ? 'top-full mt-1' : 'bottom-full mb-1'}`}
          >
            {tip}
          </span>
        </span>,
      );
    }
  }
  return (
    <div className="relative">
      <span className="sr-only">{label}</span>
      <div
        aria-hidden="true"
        className="grid gap-[3px] rounded-xl bg-[#eef2ec] dark:bg-slate-800 p-2.5"
        style={{ gridTemplateColumns: `repeat(${gridSize}, minmax(0, 1fr))` }}
      >
        {cells}
      </div>
    </div>
  );
}
