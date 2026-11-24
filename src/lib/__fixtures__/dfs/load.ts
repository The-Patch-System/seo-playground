// Test helper: real DataForSEO Local Finder task_get responses from the Nov 15 2026 archive,
// stripped to the fields the Geo-grid code reads. Descriptions keep their first two lines only.
import fs from 'fs';
import path from 'path';
import type { RawLocalItem } from '@/lib/grid-point-builder';

export interface DfsFixture {
  /** The raw task_get response body, as DataForSEO returned it (minus unused fields). */
  body: { tasks: Array<{ id: string; status_code: number; data: { keyword: string; location_coordinate: string }; result: Array<{ check_url: string; items: RawLocalItem[] }> }> };
  id: string;
  keyword: string;
  lat: number;
  lng: number;
  checkUrl: string;
  items: RawLocalItem[];
}

export const FIXTURE_NAMES = [
  'kg-bad', 'kg-good', 'fort-worth-tulsa', 'border-dc-md-va', 'border-cincinnati', 'border-philadelphia',
  'border-louisville', 'mobility-desert', 'deep-far-columbus', 'ads-alhambra', 'personal-training-la',
] as const;
export type FixtureName = typeof FIXTURE_NAMES[number];

export function loadDfsFixture(name: FixtureName): DfsFixture {
  const body = JSON.parse(fs.readFileSync(path.join(__dirname, `${name}.json`), 'utf8')) as DfsFixture['body'];
  const task = body.tasks[0];
  const [lat, lng] = task.data.location_coordinate.split(',').map(Number);
  return {
    body, id: task.id, keyword: task.data.keyword, lat, lng, checkUrl: task.result[0].check_url, items: task.result[0].items,
  };
}

/** The same response under another task id (for stubbing task_get of a re-post). */
export function withTaskId(fixture: DfsFixture, id: string): DfsFixture['body'] {
  return { tasks: fixture.body.tasks.map((t) => ({ ...t, id })) };
}
