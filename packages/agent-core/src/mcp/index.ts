/**
 * MCP — Model Context Protocol — entry point.
 *
 * Bandit speaks MCP as a CLIENT. See docs/integration-playlist/mcp-roadmap.md
 * for the phased plan. Phase 1 (this module) lays the groundwork:
 * spawn child-process MCP servers via stdio, enumerate their tools,
 * register them in Bandit's existing ToolRegistry with `<server>.<tool>`
 * names. Phase 2 layers on the user-visible config + UX.
 *
 * Off by default — a host that never registers any servers in the
 * pool gets zero behavior change. No backward-compat risk.
 */

export {
  McpClientPool,
  fingerprintServerConfig,
  type McpClientPoolOptions,
  type McpTrustGate,
  type McpToolsDiscoveredCallback,
  type RemoteToolDef as McpRemoteToolDef
} from './clientPool';
export { mcpToolToAgentTool, getAllMcpAgentTools } from './toolAdapter';
export { serveBanditMcp } from './server';
export {
  shouldActivateServer,
  effectiveTriggers,
  inferProviderHint
} from './activation';
export type {
  McpServerConfig,
  McpServersFile,
  McpServerStatus,
  McpServerSnapshot
} from './types';
