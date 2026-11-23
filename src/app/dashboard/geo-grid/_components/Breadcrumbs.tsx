import Link from 'next/link';

export interface Crumb {
  label: string;
  href?: string;
}

/** All clients › Client › Location › Keyword */
export default function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1.5 text-[13px] font-semibold text-slate-500">
      {items.map((item, index) => (
        <span key={`${item.label}-${index}`} className="flex items-center gap-1.5 min-w-0">
          {index > 0 && <span aria-hidden="true">›</span>}
          {item.href
            ? <Link href={item.href} className="text-blue-600 hover:text-blue-800 truncate">{item.label}</Link>
            : <span aria-current="page" className="truncate">{item.label}</span>}
        </span>
      ))}
    </nav>
  );
}
