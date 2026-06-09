export function setSessionValue(target: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (!(part in cursor) || typeof cursor[part] !== 'object' || cursor[part] === null) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
}

export function getSessionValue<T>(source: Record<string, unknown> | undefined, key: string): T | undefined {
  if (!source) {
    return undefined;
  }
  const parts = key.split('.');
  let value: unknown = source;
  for (const part of parts) {
    if (value && typeof value === 'object' && part in (value as Record<string, unknown>)) {
      value = (value as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return value as T;
}

export function cloneSessionData(source: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!source) {
    return undefined;
  }
  try {
    return JSON.parse(JSON.stringify(source));
  } catch {
    return undefined;
  }
}
