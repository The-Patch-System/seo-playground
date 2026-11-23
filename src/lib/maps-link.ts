// Patch fork: read a business's Google CID, pin and name from a pasted Google Maps link, so nobody
// needs a browser extension to find a CID. Works on the full URL from the address bar, a Google search
// result's link (ludocid=), and a Share short link (maps.app.goo.gl) once /api/maps-link has expanded it.

export interface MapsLinkInfo {
  cid: string | null;
  /** "lat,lng" with 6 decimals. */
  center: string | null;
  /** True when the coordinates are the listing's own pin (!3d!4d), false for the map view (@lat,lng). */
  centerIsPin: boolean;
  name: string | null;
}

function coord(lat: number, lng: number): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return `${lat.toFixed(6)},${lng.toFixed(6)}`;
}

/** Share links (maps.app.goo.gl/…, goo.gl/maps/…) carry no CID or pin until they're expanded. */
export function isShortMapsLink(raw: string): boolean {
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' && (url.hostname === 'maps.app.goo.gl' || (url.hostname === 'goo.gl' && url.pathname.startsWith('/maps')));
  } catch {
    return false;
  }
}

/** Parses a Google Maps link, a bare CID, or "lat,lng". Returns null when nothing useful is found. */
export function parseMapsInput(raw: string): MapsLinkInfo | null {
  const text = raw.trim();
  if (!text) return null;
  if (/^\d{6,25}$/.test(text)) return { cid: text, center: null, centerIsPin: false, name: null };
  const latLng = text.match(/^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (latLng) {
    const center = coord(Number(latLng[1]), Number(latLng[2]));
    return center ? { cid: null, center, centerIsPin: false, name: null } : null;
  }

  let decoded = text;
  try { decoded = decodeURIComponent(text); } catch { /* keep the raw text */ }

  // cid= on Maps links, ludocid= on links from Google search results.
  let cid: string | null = decoded.match(/[?&](?:ludo)?cid=(\d{6,25})/)?.[1] ?? null;
  if (!cid) {
    // The feature ID "0x<hex>:0x<hex>": its second half is the CID in hex.
    const hex = decoded.match(/0x[0-9a-f]+:0x([0-9a-f]+)/i)?.[1];
    if (hex) cid = BigInt(`0x${hex}`).toString();
  }

  let center: string | null = null;
  let centerIsPin = false;
  const pin = decoded.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (pin) {
    center = coord(Number(pin[1]), Number(pin[2]));
    centerIsPin = center != null;
  }
  if (!center) {
    const view = decoded.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    if (view) center = coord(Number(view[1]), Number(view[2]));
  }

  const place = decoded.match(/\/maps\/place\/([^/@?]+)/)?.[1];
  const name = place ? place.replace(/\+/g, ' ').trim() || null : null;

  if (!cid && !center && !name) return null;
  return { cid, center, centerIsPin, name };
}

/** Distance in miles between two "lat,lng" strings, or null if either is malformed. */
export function milesBetween(a: string, b: string): number | null {
  const [lat1, lng1] = a.split(',').map(Number);
  const [lat2, lng2] = b.split(',').map(Number);
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return null;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}
