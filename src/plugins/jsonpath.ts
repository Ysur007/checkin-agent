/**
 * 受限路径求值器：只支持 $.a.b、$['a']、$[0]、$[*]（取首元素）和可选链。
 * 不执行任何代码，也不支持过滤表达式。
 */
export function getPath(value: unknown, path: string): unknown {
  if (!path) return undefined;
  let rest = path.trim();
  if (rest === '$') return value;
  if (rest.startsWith('$')) rest = rest.slice(1);

  const tokens: string[] = [];
  let buffer = '';
  for (let i = 0; i < rest.length; i += 1) {
    const char = rest[i];
    if (char === '.') {
      if (buffer) tokens.push(buffer);
      buffer = '';
      continue;
    }
    if (char === '[') {
      if (buffer) {
        tokens.push(buffer);
        buffer = '';
      }
      const close = rest.indexOf(']', i);
      if (close === -1) return undefined;
      let token = rest.slice(i + 1, close).trim();
      if ((token.startsWith("'") && token.endsWith("'")) || (token.startsWith('"') && token.endsWith('"'))) {
        token = token.slice(1, -1);
      }
      tokens.push(token);
      i = close;
      continue;
    }
    if (char === '?') continue;
    buffer += char;
  }
  if (buffer) tokens.push(buffer);

  let current: unknown = value;
  for (const token of tokens) {
    if (current === null || current === undefined) return undefined;
    if (token === '*') {
      current = Array.isArray(current) ? current[0] : undefined;
      continue;
    }
    const index = Number(token);
    if (Number.isInteger(index) && String(index) === token) {
      current = Array.isArray(current) ? current[index] : undefined;
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

export function extractFields(source: unknown, mapping: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, path] of Object.entries(mapping)) {
    out[key] = getPath(source, path);
  }
  return out;
}
