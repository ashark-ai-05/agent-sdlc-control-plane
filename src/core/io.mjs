import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function readJson(path, fallback = undefined) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function appendJsonl(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...value, timestamp: new Date().toISOString() })}\n`, { flag: 'a' });
}

export function requireFile(path, label) {
  if (!existsSync(path)) die(`${label} missing: ${path}`);
  return readFileSync(path, 'utf8');
}

export function loadOptionalText(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}
