'use client';

import { useEffect, useRef, useState } from 'react';

export interface MapPin {
  row: number;
  col: number;
  lat: number;
  lng: number;
  label: string;
  color: string;
  /** Text color on the pin (dark on yellow). */
  fg: string;
  isCenter: boolean;
  /** "+2", "−1", "new", "lost" or "". */
  move: string;
  moveColor: string;
}

/**
 * The keyword's grid on a real map. Same Leaflet loading pattern as local-finder/GridMap.tsx; the
 * scroll wheel only zooms after a click, so scrolling the page doesn't zoom the map by accident.
 */
export default function KeywordMap({ pins, gridSize, label }: { pins: MapPin[]; gridSize: number; label: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import('leaflet').Map | null>(null);
  const leafletRef = useRef<typeof import('leaflet') | null>(null);
  const layerRef = useRef<import('leaflet').LayerGroup | null>(null);
  const boundsRef = useRef<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let mounted = true;
    import('leaflet').then((L) => {
      if (!mounted || !containerRef.current || mapRef.current) return;
      const map = L.map(containerRef.current, { zoomControl: true, scrollWheelZoom: false, zoomSnap: 0.25 }).setView([0, 0], 2);
      map.on('click', () => map.scrollWheelZoom.enable());
      map.on('mouseout', () => map.scrollWheelZoom.disable());
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
      }).addTo(map);
      mapRef.current = map;
      leafletRef.current = L;
      layerRef.current = L.layerGroup().addTo(map);
      setReady(true);
    });
    return () => {
      mounted = false;
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const L = leafletRef.current;
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!ready || !L || !map || !layer || pins.length === 0) return;
    const px = gridSize <= 3 ? 48 : gridSize <= 5 ? 42 : gridSize <= 7 ? 36 : 32;
    layer.clearLayers();
    for (const pin of pins) {
      const border = pin.isCenter ? '2px dashed #0f172a' : '2px solid #ffffff';
      const move = pin.move
        ? `<span style="position:absolute;bottom:-9px;left:50%;transform:translateX(-50%);border-radius:4px;background:rgba(255,255,255,.92);padding:0 3px;font-size:10px;line-height:13px;font-weight:800;color:${pin.moveColor};white-space:nowrap">${pin.move}</span>`
        : '';
      const html = `<div style="position:relative;width:${px}px;height:${px}px;border-radius:9px;background:${pin.color};color:${pin.fg};border:${border};box-sizing:border-box;display:flex;align-items:center;justify-content:center;font:800 13px Inter,system-ui,sans-serif;box-shadow:0 1px 3px rgba(15,23,42,.25)">${pin.label}${move}</div>`;
      L.marker([pin.lat, pin.lng], {
        icon: L.divIcon({ html, className: '', iconSize: [px, px], iconAnchor: [px / 2, px / 2] }),
        keyboard: false,
        interactive: false,
      }).addTo(layer);
    }
    const signature = pins.map((p) => `${p.lat}:${p.lng}`).join('|');
    if (boundsRef.current !== signature) {
      boundsRef.current = signature;
      map.fitBounds(L.latLngBounds(pins.map((p) => [p.lat, p.lng] as [number, number])), { padding: [40, 40] });
    }
  }, [ready, pins, gridSize]);

  return (
    <>
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" crossOrigin="" />
      <div className="relative">
        <div ref={containerRef} role="img" aria-label={label} className="h-[520px] w-full overflow-hidden rounded-[14px] border border-slate-200 bg-slate-100" />
        <p className="pointer-events-none absolute bottom-1.5 left-2.5 z-[400] rounded-md bg-white/85 px-1.5 py-0.5 text-[11px] text-slate-600">Click the map to zoom with the scroll wheel</p>
      </div>
    </>
  );
}
