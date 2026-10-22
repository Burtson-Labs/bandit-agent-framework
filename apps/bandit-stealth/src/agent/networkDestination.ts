/**
 * Where a network tool call will send data, for the approval card.
 *
 * Tools that contact another host ask by default (host-kit isNetworkTool).
 * The card has to show the exact destination, not a tool name: the full URL
 * for web_fetch / fetch_image (anything in the query string leaves the
 * machine), the search text and provider for web_search, the resolved remote
 * URL for git_push / git_pull, and the Bandit Cloud host for artifact tools.
 */
import { execFile } from 'child_process';
import { isNetworkTool, mcpServerOf } from '@burtson-labs/host-kit';

export interface NetworkDestination {
  /** One line naming the destination, shown on the card. */
  line: string;
  /** Short primary for the card title when the call has none (git). */
  primary?: string;
}

type GitRunner = (args: string[], cwd: string) => Promise<string>;

const defaultGit: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 3000, windowsHide: true }, (err, stdout) => {
      if (err) {reject(err);}
      else {resolve(String(stdout).trim());}
    });
  });

/** Drop a password/token from a remote URL before it is displayed. */
export function redactRemoteUrl(remoteUrl: string): string {
  try {
    const u = new URL(remoteUrl);
    if (u.password) {u.password = '***';}
    else if (u.username && /^(https?):$/.test(u.protocol)) {u.username = '***';}
    return u.toString();
  } catch {
    return remoteUrl; // scp-like git@host:path has no secret part
  }
}

/** The remote a git_push / git_pull call will contact, and its URL. */
export async function resolveGitRemote(
  params: Record<string, string>,
  workspaceRoot: string,
  push: boolean,
  git: GitRunner = defaultGit
): Promise<{ remote: string; url?: string }> {
  let remote = (params.remote ?? '').trim();
  if (!remote) {
    try {
      const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], workspaceRoot);
      remote = upstream.split('/')[0] || 'origin';
    } catch {
      remote = 'origin';
    }
  }
  try {
    const url = await git(['remote', 'get-url', ...(push ? ['--push'] : []), remote], workspaceRoot);
    return { remote, url: url ? redactRemoteUrl(url) : undefined };
  } catch {
    return { remote };
  }
}

function hostOf(raw: string | undefined, fallback: string): string {
  try {
    return new URL(raw || fallback).host;
  } catch {
    return fallback;
  }
}

/** The destination line for a network tool call, or undefined for other tools. */
export async function describeNetworkDestination(
  name: string,
  params: Record<string, string>,
  workspaceRoot: string,
  git?: GitRunner
): Promise<NetworkDestination | undefined> {
  if (!isNetworkTool(name)) {return undefined;}
  switch (name) {
    case 'web_fetch':
    case 'fetch_image':
      return { line: `Sends a request to: ${params.url ?? '(no URL)'}` };
    case 'web_search':
      return { line: `Sends this search text to Tavily (api.tavily.com): ${params.query ?? ''}` };
    case 'git_push':
    case 'git_pull':
    case 'git_fetch': {
      const push = name === 'git_push';
      const { remote, url } = await resolveGitRemote(params, workspaceRoot, push, git);
      const branch = (params.branch ?? '').trim();
      const target = url ? `${remote} (${url})` : `${remote} (URL not found in this repository)`;
      return {
        line: push
          ? `Sends your commits${branch ? ` on ${branch}` : ''} to the git remote ${target}`
          : `Fetches from the git remote ${target}${branch ? `, branch ${branch}` : ''}`,
        primary: url ?? remote
      };
    }
    case 'publish_artifact':
    case 'update_artifact':
      return {
        line: `Uploads ${params.path ?? params.file ?? 'a workspace file'} to Bandit Cloud (${hostOf(process.env.BANDIT_S3_URL, 'https://s3.burtson.ai')}) and creates a link others can open`
      };
    case 'share_artifact':
      return { line: `Creates a share link${params.url ? ` for ${params.url}` : ''} on Bandit Cloud (${hostOf(process.env.BANDIT_S3_URL, 'https://s3.burtson.ai')}) that works for anyone who has it` };
    case 'email_artifact':
      return { line: `Emails a Bandit Cloud link${params.url ? ` for ${params.url}` : ''}${params.to ? ` to ${params.to}` : ''} (${hostOf(process.env.BANDIT_S3_URL, 'https://s3.burtson.ai')})` };
    case 'generate_image':
      return { line: `Sends the image prompt to Bandit Cloud (${hostOf(process.env.BANDIT_ANTON_URL, 'https://anton.burtson.ai')})` };
    default: {
      const server = mcpServerOf(name);
      if (server) {
        return { line: `Sends these arguments to the MCP server "${server}", which is not declared local. Bandit cannot see where that server sends them.` };
      }
      return { line: `Contacts Bandit Cloud (${hostOf(process.env.BANDIT_S3_URL, 'https://s3.burtson.ai')})` };
    }
  }
}
