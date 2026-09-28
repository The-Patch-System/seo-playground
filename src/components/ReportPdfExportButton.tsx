'use client';

import { Download, LoaderCircle } from 'lucide-react';
import { useState } from 'react';

export type ReportMetric = { label: string; value: string; detail?: string };
export type ReportSection = { title: string; rows: Array<[string, string]> };

type Props = {
  brandName: string;
  brandLogoUrl?: string;
  filename: string;
  title: string;
  subject: string;
  generatedAt?: number;
  metrics: ReportMetric[];
  sections: ReportSection[];
};

const ink = [15, 23, 42] as const;
const muted = [100, 116, 139] as const;

function textForPdf(value: string, max = 110) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7E]/g, '?').slice(0, max);
}

async function readLogo(url?: string): Promise<string | null> {
  if (!url) return null;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const blob = await response.blob();
    if (!/^image\/(png|jpe?g|webp)$/i.test(blob.type)) return null;
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch { return null; }
}

export default function ReportPdfExportButton(props: Props) {
  const [exporting, setExporting] = useState(false);

  async function exportPdf() {
    setExporting(true);
    try {
      const { jsPDF } = await import('jspdf');
      const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
      const width = pdf.internal.pageSize.getWidth();
      const height = pdf.internal.pageSize.getHeight();
      const margin = 16;
      const logo = await readLogo(props.brandLogoUrl);
      const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeStyle: 'short' }).format(new Date(props.generatedAt ?? Date.now()));
      const write = (value: string, x: number, y: number, options?: Parameters<typeof pdf.text>[3]) => pdf.text(textForPdf(value), x, y, options);
      const pageHeader = () => {
        pdf.setFillColor(...ink); pdf.rect(0, 0, width, 34, 'F');
        let imageAdded = false;
        if (logo) { try { pdf.addImage(logo, margin, 8, 26, 17); imageAdded = true; } catch { /* fall back to the configured name */ } }
        if (!imageAdded) { pdf.setFont('helvetica', 'bold'); pdf.setFontSize(14); pdf.setTextColor(255, 255, 255); write(props.brandName, margin, 20); }
        pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7); pdf.setTextColor(148, 163, 184); write('SEO REPORT', width - margin, 13, { align: 'right' });
        pdf.setFontSize(14); pdf.setTextColor(255, 255, 255); write(props.title, width - margin, 21, { align: 'right' });
        pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7); pdf.setTextColor(203, 213, 225); write(date, width - margin, 27, { align: 'right' });
      };
      const footer = () => { pdf.setFontSize(7); pdf.setTextColor(...muted); write(`${props.brandName} · ${props.title}`, margin, height - 8); write(String(pdf.getNumberOfPages()), width - margin, height - 8, { align: 'right' }); };
      const newPage = () => { footer(); pdf.addPage(); pageHeader(); return 48; };

      pageHeader();
      pdf.setTextColor(...ink); pdf.setFont('helvetica', 'bold'); pdf.setFontSize(18); write(props.subject, margin, 47);
      let y = 55;
      const cols = Math.min(Math.max(props.metrics.length, 1), 4);
      const gap = 3; const cardWidth = (width - margin * 2 - gap * (cols - 1)) / cols;
      props.metrics.forEach((metric, index) => {
        const x = margin + (index % cols) * (cardWidth + gap);
        pdf.setFillColor(248, 250, 252); pdf.roundedRect(x, y, cardWidth, 23, 2.5, 2.5, 'F');
        pdf.setFont('helvetica', 'bold'); pdf.setFontSize(6.3); pdf.setTextColor(...muted); write(metric.label.toUpperCase(), x + 3, y + 6);
        pdf.setFontSize(13); pdf.setTextColor(...ink); write(metric.value, x + 3, y + 14);
        if (metric.detail) { pdf.setFont('helvetica', 'normal'); pdf.setFontSize(6.3); pdf.setTextColor(...muted); write(metric.detail, x + 3, y + 19); }
      });
      y += 32;
      for (const section of props.sections.filter((entry) => entry.rows.length > 0)) {
        if (y > height - 45) y = newPage();
        pdf.setFont('helvetica', 'bold'); pdf.setFontSize(9); pdf.setTextColor(...ink); write(section.title, margin, y); y += 5;
        for (const [label, value] of section.rows.slice(0, 24)) {
          if (y > height - 18) y = newPage();
          pdf.setDrawColor(226, 232, 240); pdf.line(margin, y + 1.8, width - margin, y + 1.8);
          pdf.setFont('helvetica', 'normal'); pdf.setFontSize(7.5); pdf.setTextColor(...muted); write(label, margin, y);
          pdf.setFont('helvetica', 'bold'); pdf.setTextColor(...ink); write(value, width - margin, y, { align: 'right' });
          y += 6;
        }
        y += 4;
      }
      footer();
      pdf.save(props.filename.endsWith('.pdf') ? props.filename : `${props.filename}.pdf`);
    } finally { setExporting(false); }
  }

  return (
    <button type="button" onClick={exportPdf} disabled={exporting}
      className="inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-slate-500 hover:text-red-600 disabled:opacity-50 transition-colors"
      title="Export PDF report">
      {exporting ? <LoaderCircle className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
      {exporting ? 'PDF…' : 'PDF'}
    </button>
  );
}
