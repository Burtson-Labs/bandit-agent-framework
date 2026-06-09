import { useCallback, useState } from "react";
import type { BanditPermissionPayload, PermissionChoice } from "@burtson-labs/agent-ui";

/**
 * Subset of the inbound `permissionRequest` wire message we need to
 * enqueue an approval. Modeled as a structural type so callers don't
 * need to import the full WebviewMessage union.
 */
export interface IncomingPermissionRequest {
  id: string;
  tool: string;
  primary: string;
  description: string;
  bodyPreview?: string;
  risk?: string;
  warning?: string;
  diffStats?: { added: number; removed: number };
  command?: string;
  paramsPreview?: string;
}

export interface ApprovalQueueHook {
  /** Pending approvals — head renders above the composer, tail waits. */
  approvalQueue: BanditPermissionPayload[];
  /**
   * Enqueue an inbound permission request. Dedupes by id (a resume
   * re-send of the same id does not stack a duplicate card on top of
   * the user's in-progress approval).
   */
  enqueueApproval: (request: IncomingPermissionRequest) => void;
  /**
   * Drop the approval whose id matches. Belt-and-suspenders for the
   * extension's `permissionResolved` confirmation — local
   * handleApprovalChoice already pops, but a webview-reload edge case
   * could leave a stale card if we only relied on client state.
   */
  resolveApproval: (id: string) => void;
  /**
   * Local commit + outbound `permissionResponse` post for the
   * head-of-queue approval card. Pops the request from the queue, then
   * posts the user's choice + optional notes back to the extension.
   */
  handleApprovalChoice: (id: string, choice: PermissionChoice, notes?: string) => void;
}

export function useApprovalQueue(): ApprovalQueueHook {
  const [approvalQueue, setApprovalQueue] = useState<BanditPermissionPayload[]>([]);

  const enqueueApproval = useCallback((request: IncomingPermissionRequest) => {
    setApprovalQueue((prev) => {
      if (prev.some((p) => p.id === request.id)) {return prev;}
      const payload: BanditPermissionPayload = {
        type: "bandit:permission",
        id: request.id,
        tool: request.tool,
        primary: request.primary,
        description: request.description,
        bodyPreview: request.bodyPreview,
        risk: request.risk,
        warning: request.warning,
        diffStats: request.diffStats,
        command: request.command,
        paramsPreview: request.paramsPreview
      };
      return [...prev, payload];
    });
  }, []);

  const resolveApproval = useCallback((id: string) => {
    setApprovalQueue((prev) => prev.filter((p) => p.id !== id));
  }, []);

  const handleApprovalChoice = useCallback(
    (id: string, choice: PermissionChoice, notes?: string) => {
      setApprovalQueue((prev) => prev.filter((p) => p.id !== id));
      vscode.postMessage({ type: "permissionResponse", id, choice, notes });
    },
    []
  );

  return { approvalQueue, enqueueApproval, resolveApproval, handleApprovalChoice };
}
