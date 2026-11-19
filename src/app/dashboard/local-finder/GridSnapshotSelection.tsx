'use client';

import type { BrandStyle } from '@/lib/brand';

import { createContext, useContext, type ReactNode } from 'react';
import type { GridPoint } from '@/lib/db';
import GridPdfExportButton from './GridPdfExportButton';

export type GridSnapshotSelection = {
  activeId: string;
  setActiveId: (id: string) => void;
  /** Runs on Export PDF click, before the map is captured (e.g. to clear a competitor highlight). */
  beforeExport?: () => void;
};

const SnapshotSelectionContext = createContext<GridSnapshotSelection | null>(null);

/**
 * Shares the snapshot (date) currently displayed on the map with the PDF export.
 * Controlled: the owner (GridMonitorView) holds the state and passes it in.
 */
export function GridSnapshotSelectionProvider({ value, children }: { value: GridSnapshotSelection; children: ReactNode }) {
  return <SnapshotSelectionContext.Provider value={value}>{children}</SnapshotSelectionContext.Provider>;
}

export function useGridSnapshotSelection(): GridSnapshotSelection | null {
  return useContext(SnapshotSelectionContext);
}

type ExportSnapshot = { id: string; ts: number; results: GridPoint[] };

type ExportProps = {
  snapshots: ExportSnapshot[];
  fallbackResults: GridPoint[];
  fallbackTs: number;
  gridSize: number;
  spacingKm: number;
  keyword: string;
  target: string;
  language: string;
  brandName: string;
  brandLogoUrl?: string;
  brandColor?: string;
  brandFooter?: string;
  brandStyle?: Partial<BrandStyle>;
  mapElementId: string;
};

/** PDF export bound to the snapshot currently selected on the map. */
export function GridSelectedSnapshotExportButton({ snapshots, fallbackResults, fallbackTs, ...rest }: ExportProps) {
  const selection = useGridSnapshotSelection();
  const active = snapshots.find((snapshot) => snapshot.id === selection?.activeId);
  return (
    // Capture phase: the highlight is cleared before the export handler starts, so the PDF
    // embeds the target's own ranks rather than a competitor's.
    <span className="contents" onClickCapture={selection?.beforeExport}>
      <GridPdfExportButton
        {...rest}
        results={active?.results ?? fallbackResults}
        searchedAt={active?.ts ?? fallbackTs}
      />
    </span>
  );
}
