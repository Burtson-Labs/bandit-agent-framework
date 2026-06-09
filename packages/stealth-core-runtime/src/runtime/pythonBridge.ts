import fs from 'fs';
import type { IShellAdapter, IPythonEnv, PythonResponse } from '../internalTypes';

export interface PythonBridgeDeps {
  pythonEnv: IPythonEnv;
  shellAdapter: IShellAdapter;
  getScriptPath(): string;
  getWorkingDirectory(): string;
  onMissingPython(detail?: string): Promise<void>;
}

export interface PythonBridge {
  run(action: string, payload: unknown): Promise<PythonResponse>;
}

export function createPythonBridge(deps: PythonBridgeDeps): PythonBridge {
  async function run(action: string, payload: unknown): Promise<PythonResponse> {
    const scriptPath = deps.getScriptPath();
     
    console.info('[Bandit Stealth] Python run start', { action, scriptPath });
    const python = await deps.pythonEnv.ensure();
     
    console.info('[Bandit Stealth] Python ensure result', python);
    if (!python.ok || !python.command) {
      const detail = python.error ?? 'Python 3 runtime not detected.';
       
      console.error('[Bandit Stealth] Python ensure failed', { action, scriptPath, detail });
      await deps.onMissingPython(detail);
      return {
        status: 'FAILED',
        error: detail
      };
    }

    try {
      const response = await invokePython(python.command, scriptPath, action, payload);
      if (response.status !== 'SUCCESS') {
        const reason = response.error?.trim() || 'Python action failed.';
        const output = (response.output ?? '').trim();
        const detail = output
          ? `${reason} | output: ${output} | command: ${python.command} | script: ${scriptPath}`
          : `${reason} | command: ${python.command} | script: ${scriptPath}`;
        // Surface in debug console for fast diagnosis
         
        console.error('[Bandit Stealth] Python invocation failed', {
          action,
          scriptPath,
          command: python.command,
          response
        });
        await deps.onMissingPython(detail);
      }
      return response;
    } catch (error) {
      await deps.pythonEnv.clearCache();
      const message = error instanceof Error ? error.message : String(error);
      const detail = `Failed to launch Python command "${python.command}" with script "${scriptPath}": ${message}`;
       
      console.error('[Bandit Stealth] Python launch error', {
        action,
        scriptPath,
        command: python.command,
        error: message
      });
      await deps.onMissingPython(detail);
      return {
        status: 'FAILED',
        error: `Failed to launch Python command "${python.command}".`,
        details: detail
      };
    }
  }

  async function invokePython(
    command: string,
    scriptPath: string,
    action: string,
    payload: unknown
  ): Promise<PythonResponse> {
    if (!fs.existsSync(scriptPath)) {
      const error = `Python script not found at ${scriptPath}`;
       
      console.error('[Bandit Stealth] Python script missing', { scriptPath });
      return { status: 'FAILED', error };
    }
    const args = command === 'py' ? ['-3', scriptPath] : [scriptPath];
    const input = JSON.stringify({ action, payload });
    const result = await deps.shellAdapter.run(command, args, {
      cwd: deps.getWorkingDirectory(),
      input
    });
     
    console.info('[Bandit Stealth] Python process result', {
      command,
      args,
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr
    });
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    if (!stdout.trim() && stderr.trim()) {
       
      console.error('[Bandit Stealth] Python stderr', { command, scriptPath, stderr, code: result.code });
      return { status: 'FAILED', error: stderr.trim(), output: stdout, code: result.code };
    }
    try {
      return JSON.parse(stdout || '{}') as PythonResponse;
    } catch (error) {
       
      console.error('[Bandit Stealth] Invalid Python output', {
        command,
        scriptPath,
        stdout,
        stderr,
        code: result.code,
        error: error instanceof Error ? error.message : String(error)
      });
      return {
        status: 'FAILED',
        error: 'Invalid Python output',
        details: error instanceof Error ? error.message : String(error),
        output: stdout,
        code: result.code
      };
    }
  }

  return { run };
}
