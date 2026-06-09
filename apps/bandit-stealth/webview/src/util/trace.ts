export function formatTraceTimestamp(value?: string): string {
  if (!value) {return "unknown";}
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {return value;}
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function traceBasename(value?: string): string {
  if (!value) {return "unknown";}
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).pop() ?? value;
}
