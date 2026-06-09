/**
 * MCP message handlers — lifecycle (reload / reconnect / disconnect /
 * setActivation / revokeTrust) and the connection wizards (GitHub /
 * Slack / GitLab / Gmail / Custom).
 *
 * Both families share the same pattern: build a small lifecycle/
 * wizard context that wires the `ctx.mcp.reloadFromDisk` and
 * `ctx.postMessage` paths the legacy helpers in `helpers/mcpLifecycle`
 * and `helpers/mcpWizards` already expect, then dispatch by message
 * type. Pulling them out of the provider's giant handleMessage
 * dispatcher removes a 50-line clump that was just shape-building +
 * a switch.
 */
import * as vscode from 'vscode';
import {
  handleMcpDisconnect,
  handleMcpReconnect,
  handleMcpReload,
  handleMcpRevokeTrust,
  handleMcpSetActivation,
  type McpLifecycleContext
} from '../../helpers/mcpLifecycle';
import {
  runCustomWizard,
  runGitHubWizard,
  runGitLabWizard,
  runGmailWizard,
  runSlackWizard,
  type McpWizardContext
} from '../../helpers/mcpWizards';
import type { IncomingMessage } from '../../messages';
import type { ProviderContext } from '../context';

export type McpLifecycleMessage = Extract<
  IncomingMessage,
  { type: 'mcpReload' | 'mcpReconnect' | 'mcpDisconnect' | 'mcpSetActivation' | 'mcpRevokeTrust' }
>;

export type McpWizardMessage = Extract<
  IncomingMessage,
  { type: 'mcpAddGitHub' | 'mcpAddSlack' | 'mcpAddGitLab' | 'mcpAddGmail' | 'mcpAddCustom' }
>;

export async function handleMcpLifecycleMessage(
  message: McpLifecycleMessage,
  ctx: ProviderContext
): Promise<void> {
  const lifecycleCtx: McpLifecycleContext = {
    mcpPool: ctx.mcpPool,
    workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
    reloadFromDisk: (root) => ctx.mcp.reloadFromDisk(root),
    postMessage: (msg) => ctx.postMessage(msg),
    syncState: () => ctx.syncState()
  };
  switch (message.type) {
    case 'mcpReload':
      await handleMcpReload(lifecycleCtx);
      break;
    case 'mcpReconnect':
      await handleMcpReconnect(lifecycleCtx, message.name);
      break;
    case 'mcpDisconnect':
      await handleMcpDisconnect(lifecycleCtx, message.name);
      break;
    case 'mcpSetActivation':
      await handleMcpSetActivation(lifecycleCtx, message.name, message.activation);
      break;
    case 'mcpRevokeTrust':
      await handleMcpRevokeTrust(lifecycleCtx, message.name);
      break;
  }
}

export async function handleMcpWizardMessage(
  message: McpWizardMessage,
  ctx: ProviderContext
): Promise<void> {
  const wizardCtx: McpWizardContext = {
    workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
    reloadAndSync: async () => {
      await ctx.mcp.reloadFromDisk(wizardCtx.workspaceRoot);
      await ctx.syncState();
    },
    postMessage: (msg) => ctx.postMessage(msg)
  };
  switch (message.type) {
    case 'mcpAddGitHub':
      await runGitHubWizard(wizardCtx);
      break;
    case 'mcpAddSlack':
      await runSlackWizard(wizardCtx);
      break;
    case 'mcpAddGitLab':
      await runGitLabWizard(wizardCtx);
      break;
    case 'mcpAddGmail':
      await runGmailWizard(wizardCtx);
      break;
    case 'mcpAddCustom':
      await runCustomWizard(wizardCtx);
      break;
  }
}

const LIFECYCLE_TYPES = new Set<IncomingMessage['type']>([
  'mcpReload', 'mcpReconnect', 'mcpDisconnect', 'mcpSetActivation', 'mcpRevokeTrust'
]);
const WIZARD_TYPES = new Set<IncomingMessage['type']>([
  'mcpAddGitHub', 'mcpAddSlack', 'mcpAddGitLab', 'mcpAddGmail', 'mcpAddCustom'
]);

/**
 * Topic dispatcher — returns `true` if the message is an MCP lifecycle
 * or wizard message (and was handled), `false` otherwise. Collapses 2
 * if-blocks (with 10 message types) in the provider's `handleMessage`.
 */
export async function dispatchMcpMessage(
  ctx: ProviderContext,
  message: IncomingMessage
): Promise<boolean> {
  if (LIFECYCLE_TYPES.has(message.type)) {
    await handleMcpLifecycleMessage(message as McpLifecycleMessage, ctx);
    return true;
  }
  if (WIZARD_TYPES.has(message.type)) {
    await handleMcpWizardMessage(message as McpWizardMessage, ctx);
    return true;
  }
  return false;
}
