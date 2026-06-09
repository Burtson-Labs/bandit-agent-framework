import * as cp from 'child_process';

export interface CliNotificationSettings {
  desktop: boolean;
  sound: boolean;
  minTurnMs: number;
}

export type CliNotificationKind = 'approval' | 'complete' | 'error' | 'background';

export interface CliNotification {
  kind: CliNotificationKind;
  title: string;
  message: string;
  durationMs?: number;
}

export function notifyCli(settings: CliNotificationSettings, notification: CliNotification): void {
  if (settings.sound) {
    process.stdout.write('\x07');
  }
  if (!settings.desktop) return;
  if (notification.kind === 'complete' && (notification.durationMs ?? 0) < settings.minTurnMs) return;

  const message = notification.message.slice(0, 240);
  if (process.platform === 'darwin') {
    const script = [
      'display notification ',
      appleString(message),
      ' with title ',
      appleString(notification.title)
    ].join('');
    spawnDetached('osascript', ['-e', script]);
    return;
  }

  if (process.platform === 'linux') {
    spawnDetached('notify-send', [notification.title, message]);
  }
}

function spawnDetached(command: string, args: string[]): void {
  try {
    cp.spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // Notification delivery is best-effort; never let it affect the agent turn.
  }
}

function appleString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
