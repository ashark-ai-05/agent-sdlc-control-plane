import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export function stringifyScalar(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

export function setDeep(obj, dottedKey, rawValue) {
  const parts = dottedKey.split('.').filter(Boolean);
  if (parts.length === 0) throw new Error('--set-key must not be empty');
  let cursor = obj;
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = stringifyScalar(rawValue);
}

export function formatYamlScalar(raw) {
  const value = stringifyScalar(raw);
  if (typeof value === 'boolean' || typeof value === 'number' || value === null) return String(value);
  if (/^[A-Za-z0-9_./:-]+$/.test(String(value))) return String(value);
  return JSON.stringify(String(value));
}

export function setYamlValue(text, dottedKey, rawValue, runId) {
  const parts = dottedKey.split('.').filter(Boolean);
  if (!parts.length) throw new Error('--set-key must not be empty');
  const lines = text.split(/\r?\n/).filter((line, idx, arr) => !(idx === arr.length - 1 && line === ''));
  const valueText = formatYamlScalar(rawValue);

  function findKey(start, end, indent, key) {
    const re = new RegExp(`^\\s{${indent}}${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`);
    for (let i = start; i < end; i++) {
      if (re.test(lines[i])) return i;
    }
    return -1;
  }

  function blockEnd(start, indent) {
    let i = start + 1;
    for (; i < lines.length; i++) {
      if (!lines[i].trim() || lines[i].trim().startsWith('#')) continue;
      const currentIndent = lines[i].match(/^ */)[0].length;
      if (currentIndent <= indent) break;
    }
    return i;
  }

  let start = 0;
  let end = lines.length;
  let indent = 0;
  let insertAt = lines.length;
  for (let depth = 0; depth < parts.length; depth++) {
    const key = parts[depth];
    const idx = findKey(start, end, indent, key);
    const isLeaf = depth === parts.length - 1;
    if (idx >= 0) {
      if (isLeaf) {
        lines[idx] = `${' '.repeat(indent)}${key}: ${valueText}`;
        return `${lines.join('\n')}\n`;
      }
      start = idx + 1;
      end = blockEnd(idx, indent);
      insertAt = end;
      indent += 2;
      continue;
    }
    const newLines = [];
    if (!lines.some((line) => line.includes(`agent-sdlc mock config change for ${runId}`))) {
      newLines.push(`${' '.repeat(indent)}# agent-sdlc mock config change for ${runId}`);
    }
    for (let j = depth; j < parts.length; j++) {
      const isFinal = j === parts.length - 1;
      newLines.push(`${' '.repeat(indent + (j - depth) * 2)}${parts[j]}:${isFinal ? ` ${valueText}` : ''}`);
    }
    lines.splice(insertAt, 0, ...newLines);
    return `${lines.join('\n')}\n`;
  }
  return `${lines.join('\n')}\n`;
}

export function applyConfigChange(targetPath, key, value, runId) {
  if (!existsSync(targetPath)) throw new Error(`target file does not exist: ${targetPath}`);
  const before = readFileSync(targetPath, 'utf8');
  const lower = targetPath.toLowerCase();
  let after;

  if (lower.endsWith('.json')) {
    const parsed = JSON.parse(before || '{}');
    setDeep(parsed, key, value);
    after = `${JSON.stringify(parsed, null, 2)}\n`;
  } else if (lower.endsWith('.properties')) {
    const lines = before.split(/\r?\n/).filter((line, idx, arr) => !(idx === arr.length - 1 && line === ''));
    const idx = lines.findIndex((line) => line.trim().startsWith(`${key}=`));
    if (idx >= 0) lines[idx] = `${key}=${value}`;
    else lines.push(`# agent-sdlc mock config change for ${runId}`, `${key}=${value}`);
    after = `${lines.join('\n')}\n`;
  } else if (lower.endsWith('.yml') || lower.endsWith('.yaml')) {
    after = setYamlValue(before, key, value, runId);
  } else {
    after = `${before.replace(/\s*$/, '\n')}# agent-sdlc mock config change for ${runId}\n${key}=${value}\n`;
  }

  if (after !== before) writeFileSync(targetPath, after);
}

export function basicYamlValidation(text) {
  const errors = [];
  const stack = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!line.trim() || line.trim().startsWith('#')) return;
    const indent = line.match(/^ */)[0].length;
    if (indent % 2 !== 0) errors.push(`line ${index + 1}: indentation should use multiples of two spaces`);
    const trimmed = line.trim();
    if (trimmed.includes('\t')) errors.push(`line ${index + 1}: tabs are not allowed in YAML indentation`);
    if (!trimmed.startsWith('- ') && !trimmed.includes(':')) errors.push(`line ${index + 1}: expected key/value separator ':'`);
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    if (/^[^:#][^:]*:\s*$/.test(trimmed)) stack.push({ indent, key: trimmed.slice(0, -1) });
  });
  return errors;
}

export function validateConfigFile(path) {
  const lower = path.toLowerCase();
  const text = readFileSync(path, 'utf8');
  const result = { file: path, ok: true, type: 'unknown', errors: [] };
  try {
    if (lower.endsWith('.json')) {
      result.type = 'json';
      JSON.parse(text || '{}');
    } else if (lower.endsWith('.yml') || lower.endsWith('.yaml')) {
      result.type = 'yaml';
      result.errors.push(...basicYamlValidation(text));
    } else if (lower.endsWith('.properties')) {
      result.type = 'properties';
      text.split(/\r?\n/).forEach((line, index) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) return;
        if (!trimmed.includes('=') && !trimmed.includes(':')) result.errors.push(`line ${index + 1}: expected key=value or key:value`);
      });
    } else if (lower.endsWith('.toml')) {
      result.type = 'toml';
      text.split(/\r?\n/).forEach((line, index) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[')) return;
        if (!trimmed.includes('=')) result.errors.push(`line ${index + 1}: expected key=value`);
      });
    }
  } catch (error) {
    result.errors.push(error.message);
  }
  result.ok = result.errors.length === 0;
  return result;
}
