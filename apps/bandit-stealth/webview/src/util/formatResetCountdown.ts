export function formatResetCountdown(resetsAtUnix?: number): string {
  if (!resetsAtUnix) {return "—";}
  const now = Math.floor(Date.now() / 1000);
  const diff = resetsAtUnix - now;
  if (diff <= 0) {return "any moment";}
  const hours = Math.floor(diff / 3600);
  const minutes = Math.floor((diff % 3600) / 60);
  if (hours >= 24) {
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return `${days}d ${remHours}h`;
  }
  if (hours >= 1) {return `${hours}h ${minutes}m`;}
  return `${Math.max(1, minutes)}m`;
}
