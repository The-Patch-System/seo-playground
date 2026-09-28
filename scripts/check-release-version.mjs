import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const tag = process.env.RELEASE_TAG;
const expected = `v${packageJson.version}`;

if (!tag) {
  console.error('RELEASE_TAG is required (for example: v0.4.0).');
  process.exit(1);
}

if (tag !== expected) {
  console.error(`Release tag ${tag} does not match package.json version ${expected}.`);
  process.exit(1);
}

console.log(`Release version verified: ${tag}`);
