import type { GridPoint } from '@/lib/db';
import { rankColor, rankLabel } from '@/lib/grid-locations';

/**
 * A small heatmap of one scan, at the keyword's real grid size. Gray = outside the top 20 or no data.
 * Purely visual: the card around it carries the numbers for screen readers.
 */
export default function MiniGrid({ points, gridSize, label }: { points: GridPoint[]; gridSize: number; label: string }) {
  const byCell = new Map(points.map((p) => [`${p.row}:${p.col}`, p]));
  const cells = [];
  for (let row = 0; row < gridSize; row += 1) {
    for (let col = 0; col < gridSize; col += 1) {
      const point = byCell.get(`${row}:${col}`);
      cells.push(
        <i
          key={`${row}:${col}`}
          title={`Row ${row + 1}, column ${col + 1}: ${rankLabel(point)}`}
          className="block aspect-square rounded-[3px]"
          style={{ background: rankColor(point) }}
        />,
      );
    }
  }
  return (
    <span
      role="img"
      aria-label={label}
      className="grid gap-[3px] rounded-xl bg-[#eef2ec] dark:bg-slate-800 p-2.5"
      style={{ gridTemplateColumns: `repeat(${gridSize}, minmax(0, 1fr))` }}
    >
      {cells}
    </span>
  );
}
