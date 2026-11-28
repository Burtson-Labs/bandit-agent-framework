import type { IShellAdapter } from '../../internalTypes';

const isBrowser = typeof window !== 'undefined';

async function getSpawn() {
  if (isBrowser) {
    throw new Error('Shell adapter is unavailable in the browser host');
  }
  const mod = await import('child_process');
  return mod.spawn;
}

export interface ShellAdapterOptions {
  env?: NodeJS.ProcessEnv;
}

export function createShellAdapter(options: ShellAdapterOptions = {}): IShellAdapter {
  if (isBrowser) {
    const thrower = () => {
      throw new Error('Shell adapter is unavailable in the browser host');
    };
    return {
      run: async () => {
        thrower();
        return { code: -1, stdout: '', stderr: '' };
      }
    };
  }

  const env = options.env ?? process.env;

  return {
    async run(
      cmd: string,
      args: string[],
      opts: { cwd?: string; timeoutMs?: number; input?: string | Buffer; windowsVerbatimArguments?: boolean } = {}
    ): Promise<{ code: number; stdout: string; stderr: string }> {
      const spawn = await getSpawn();
      return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
          cwd: opts.cwd,
          env,
          windowsVerbatimArguments: opts.windowsVerbatimArguments,
          stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = opts.timeoutMs
          ? setTimeout(() => {
              timedOut = true;
              child.kill();
            }, opts.timeoutMs)
          : undefined;

        // Decode as a stream: a multi-byte UTF-8 character split across two
        // pipe reads must not turn into two U+FFFD (chunk.toString() per read did).
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.stderr?.on('data', (chunk: string) => {
          stderr += chunk;
        });

        if (opts.input !== undefined && child.stdin) {
          const input = typeof opts.input === 'string' || Buffer.isBuffer(opts.input)
            ? opts.input
            : Buffer.from(String(opts.input));
          child.stdin.on('error', (error) => {
            if (timer) {
              clearTimeout(timer);
            }
            reject(error);
          });
          child.stdin.end(input);
        }

        child.on('error', (error) => {
          if (timer) {
            clearTimeout(timer);
          }
          reject(error);
        });

        child.on('close', (code) => {
          if (timer) {
            clearTimeout(timer);
          }
          if (timedOut) {
            reject(new Error(`Command "${cmd}" timed out after ${opts.timeoutMs}ms.`));
            return;
          }
          resolve({
            code: typeof code === 'number' ? code : -1,
            stdout,
            stderr
          });
        });
      });
    }
  };
}
