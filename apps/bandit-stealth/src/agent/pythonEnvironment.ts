import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as fs from 'fs';
import type { OutputChannel } from 'vscode';
import * as path from 'path';

interface PythonInfo {
  command: string;
  version: string;
  major: number;
  minor: number;
}

interface PythonCheckResult {
  info?: PythonInfo;
  error?: string;
}

let cachedResult: PythonCheckResult | undefined;

const PYTHON_CONFIGURATION_KEY = 'banditStealth.pythonPath';

const DEFAULT_COMMANDS = process.platform === 'win32'
  ? ['python', 'py', 'python3']
  : ['python3', 'python', 'python3.12', 'python3.11', 'python3.10'];

function getCommonPythonPaths(): string[] {
  if (process.platform === 'win32') {
    return [];
  }

  const paths = ['/usr/local/bin/python3', '/usr/bin/python3'];

  if (process.platform === 'darwin') {
    paths.unshift('/opt/homebrew/bin/python3', '/opt/homebrew/opt/python@3.12/bin/python3');
    paths.push(
      '/Library/Frameworks/Python.framework/Versions/Current/bin/python3',
      '/Library/Frameworks/Python.framework/Versions/3.12/bin/python3',
      '/Library/Frameworks/Python.framework/Versions/3.11/bin/python3',
      '/Library/Frameworks/Python.framework/Versions/3.10/bin/python3',
      '/opt/local/bin/python3'
    );
  }

  const home = process.env.HOME;
  if (home) {
    paths.push(
      `${home}/.pyenv/shims/python3`,
      `${home}/.asdf/shims/python3`,
      `${home}/.local/bin/python3`,
      `${home}/miniconda3/bin/python3`,
      `${home}/anaconda3/bin/python3`
    );
  }

  return paths;
}

function discoverFilesystemCandidates(): string[] {
  const candidates: string[] = [];
  const checkPaths = (list: string[]) => {
    for (const entry of list) {
      if (!entry) {continue;}
      try {
        if (fs.existsSync(entry)) {
          candidates.push(entry);
        }
      } catch {
        // ignore fs errors
      }
    }
  };

  // Common versioned Homebrew locations (Intel + ARM)
  checkPaths([
    '/opt/homebrew/bin/python3',
    '/opt/homebrew/opt/python@3.12/bin/python3',
    '/opt/homebrew/opt/python@3.11/bin/python3',
    '/opt/homebrew/opt/python@3.10/bin/python3',
    '/usr/local/bin/python3',
    '/usr/local/opt/python@3.12/bin/python3',
    '/usr/local/opt/python@3.11/bin/python3',
    '/usr/local/opt/python@3.10/bin/python3',
    '/opt/local/bin/python3'
  ]);

  // Python.org installs
  checkPaths([
    '/Library/Frameworks/Python.framework/Versions/3.12/bin/python3',
    '/Library/Frameworks/Python.framework/Versions/3.11/bin/python3',
    '/Library/Frameworks/Python.framework/Versions/3.10/bin/python3',
    '/Library/Frameworks/Python.framework/Versions/Current/bin/python3'
  ]);

  // pyenv / asdf shims and version installs
  const home = process.env.HOME;
  if (home) {
    checkPaths([
      `${home}/.pyenv/shims/python3`,
      `${home}/.asdf/shims/python3`,
      `${home}/.local/bin/python3`,
      `${home}/miniconda3/bin/python3`,
      `${home}/anaconda3/bin/python3`
    ]);

    const pyenvVersionsDir = `${home}/.pyenv/versions`;
    try {
      const versions = fs.readdirSync(pyenvVersionsDir, { withFileTypes: true });
      for (const entry of versions) {
        if (entry.isDirectory()) {
          const candidate = `${pyenvVersionsDir}/${entry.name}/bin/python3`;
          if (fs.existsSync(candidate)) {
            candidates.push(candidate);
          }
        }
      }
    } catch {
      // ignore if pyenv is not installed
    }
  }

  return candidates;
}

let pythonLog: OutputChannel | undefined;
function logDetection(message: string) {
  if (!pythonLog) {
    pythonLog = vscode.window.createOutputChannel('Bandit Stealth Python');
  }
  pythonLog.appendLine(message);
}

function getSpawnEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const extra = new Set<string>();

  for (const candidate of getCommonPythonPaths()) {
    if (candidate.startsWith('/')) {
      extra.add(path.dirname(candidate));
    }
  }

  // VS Code sometimes launches with a minimal PATH; prime it with common locations
  const defaults = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];
  for (const dir of defaults) {
    extra.add(dir);
  }

  const existing = env.PATH ? env.PATH.split(path.delimiter) : [];
  env.PATH = Array.from(extra).concat(existing).join(path.delimiter);
  return env;
}

export async function ensurePython(
  options: { force?: boolean } = {}
): Promise<PythonCheckResult> {
  if (!options.force && cachedResult?.info) {
    return cachedResult;
  }

  const commands = await gatherCandidateCommands();
  let lastError: string | undefined;

  logDetection(
    [
      'Starting Python detection',
      `configuredPath="${vscode.workspace.getConfiguration('banditStealth').get<string | null>(PYTHON_CONFIGURATION_KEY) ?? ''}"`,
      `PATH="${getSpawnEnv().PATH ?? ''}"`,
      `candidates=[${commands.join(', ')}]`
    ].join(' | ')
  );
   
  console.info('[Bandit Stealth] Python detection starting', { candidates: commands });

  for (const command of commands) {
    const probe = await probePython(command);
    if (probe.info) {
      cachedResult = { info: probe.info };
      logDetection(`Detected Python: command="${probe.info.command}" version="${probe.info.version}"`);

      console.info('[Bandit Stealth] Python detected', { command: probe.info.command, version: probe.info.version });
      return cachedResult;
    }
    if (!lastError && probe.error) {
      lastError = probe.error;
    }
    logDetection(`Probe failed for "${command}": ${probe.error ?? 'unknown error'}`);
  }

  const error = buildErrorMessage(commands, lastError);
  logDetection(`Python detection failed: ${error}`);

  console.error('[Bandit Stealth] Python detection failed', { error, candidates: commands, lastError });
  cachedResult = { error };
  return cachedResult;
}

export function getCachedPythonInfo(): PythonInfo | undefined {
  return cachedResult?.info;
}

export function clearPythonCache(): void {
  cachedResult = undefined;
}

async function gatherCandidateCommands(): Promise<string[]> {
  const configuration = vscode.workspace.getConfiguration('banditStealth');
  const configuredPath = configuration.get<string | null>(PYTHON_CONFIGURATION_KEY) ?? undefined;
  const candidates = new Set<string>();

  if (configuredPath && configuredPath.trim().length > 0) {
    candidates.add(configuredPath.trim());
  }

  for (const command of DEFAULT_COMMANDS) {
    candidates.add(command);
  }

  for (const absolutePath of getCommonPythonPaths()) {
    candidates.add(absolutePath);
  }

  for (const absolutePath of discoverFilesystemCandidates()) {
    candidates.add(absolutePath);
  }

  return Array.from(candidates);
}

async function probePython(command: string): Promise<{ info?: PythonInfo; error?: string }> {
  const script = `
import json, sys
print(json.dumps({
  "major": sys.version_info.major,
  "minor": sys.version_info.minor,
  "version": sys.version,
  "exe": sys.executable
}))
`.trim();
  const args = command === 'py' ? ['-3', '-c', script] : ['-c', script];

  try {
    const output = await runCommand(command, args);
    const parsed = parseProbeOutput(output);
    if (!parsed || parsed.major < 3 || !parsed.exe) {
      return { error: 'Python 3 or later is required.' };
    }

    return {
      info: {
        command: parsed.exe,
        version: parsed.version,
        major: parsed.major,
        minor: parsed.minor
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: message };
  }
}

async function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: getSpawnEnv()
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0 && stdout.trim().length > 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(stderr.trim() || `Command failed with exit code ${code}`));
    });
  });
}

function parseProbeOutput(raw: string): { major: number; minor: number; version: string; exe?: string } | undefined {
  try {
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== 'object'
      || parsed === null
      || typeof parsed.version !== 'string'
      || typeof parsed.major !== 'number'
      || typeof parsed.minor !== 'number'
    ) {
      return undefined;
    }
    return {
      version: parsed.version,
      major: parsed.major,
      minor: parsed.minor,
      exe: typeof parsed.exe === 'string' ? parsed.exe : undefined
    };
  } catch {
    return undefined;
  }
}

function buildErrorMessage(commands: string[], lastError?: string): string {
  const configured = vscode.workspace.getConfiguration('banditStealth')
    .get<string | null>(PYTHON_CONFIGURATION_KEY);

  const base = configured && configured.trim().length > 0
    ? `Python 3 was not found at "${configured}".`
    : 'Python 3 was not detected on your system.';

  const attempted = commands.length > 0
    ? ` Tried commands: ${commands.join(', ')}.`
    : '';

  const detail = lastError ? ` Last error: ${lastError}.` : '';
  const pathEnv = getSpawnEnv().PATH ?? '';
  const pathInfo = pathEnv ? ` PATH used: ${pathEnv}` : '';

  return `${base}${attempted}${detail}${pathInfo}`;
}
