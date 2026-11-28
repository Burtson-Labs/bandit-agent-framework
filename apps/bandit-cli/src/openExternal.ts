/**
 * Open a URL or file in the user's default handler without a shell.
 *
 * Windows has no `start` executable (it is a cmd.exe builtin), and routing a
 * URL through `cmd /c start` or `shell: true` lets cmd interpret `&`, `|` and
 * `^` in the URL: a query string is cut at the first `&` and the rest runs as
 * a command. `rundll32 url.dll,FileProtocolHandler <target>` hands the target
 * to the default handler as a single argument, for URLs and file paths alike.
 */
import { spawn } from 'child_process';

export function openerCommand(target: string, platform: NodeJS.Platform = process.platform): { cmd: string; args: string[] } {
  if (platform === 'darwin') return { cmd: 'open', args: [target] };
  if (platform === 'win32') return { cmd: 'rundll32', args: ['url.dll,FileProtocolHandler', target] };
  return { cmd: 'xdg-open', args: [target] };
}

/** Fire-and-forget open. Returns false only when the spawn itself throws. */
export function openExternal(target: string): boolean {
  try {
    const { cmd, args } = openerCommand(target);
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => undefined); // opener missing: the caller already printed the target
    child.unref();
    return true;
  } catch {
    return false;
  }
}
