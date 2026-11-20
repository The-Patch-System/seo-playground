// URLs for the location-based Geo-grid pages. Every one carries the project ID, so a page never
// depends on the sidebar's "active project".
export const CLIENTS_URL = '/dashboard/geo-grid/clients';

export function clientUrl(projectId: string) {
  return `${CLIENTS_URL}/${encodeURIComponent(projectId)}`;
}

export function locationUrl(projectId: string, locationId: string) {
  return `${clientUrl(projectId)}/locations/${encodeURIComponent(locationId)}`;
}

export function keywordUrl(projectId: string, locationId: string, seriesId: string) {
  return `${locationUrl(projectId, locationId)}/keywords/${encodeURIComponent(seriesId)}`;
}
