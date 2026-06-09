/**
 * Arc W3-S1.3 — contract tests for useApprovalQueue.
 *
 * Pins:
 * - FIFO order on enqueue (head renders above the composer; tail waits)
 * - dedup-by-id on enqueue (resume re-send doesn't stack a duplicate)
 * - the BanditPermissionPayload shape the queue stores
 * - the outbound permissionResponse wire format on a choice
 * - resolveApproval's belt-and-suspenders cleanup for the
 *   extension-side `permissionResolved` confirmation
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useApprovalQueue } from '../../src/hooks/useApprovalQueue';
import { mockPostMessage, type PostMessageRecorder } from '../_helpers';

let recorder: PostMessageRecorder;

const baseRequest = (id: string) => ({
  id,
  tool: 'read_file',
  primary: `Read foo/${id}`,
  description: `desc-${id}`
});

beforeEach(() => {
  recorder = mockPostMessage();
});

afterEach(() => {
  cleanup();
});

describe('useApprovalQueue', () => {
  it('initial queue is empty', () => {
    const { result } = renderHook(() => useApprovalQueue());
    expect(result.current.approvalQueue).toEqual([]);
  });

  it('enqueueApproval appends FIFO and stamps the BanditPermissionPayload type', () => {
    const { result } = renderHook(() => useApprovalQueue());
    act(() => {
      result.current.enqueueApproval(baseRequest('a'));
      result.current.enqueueApproval(baseRequest('b'));
    });
    expect(result.current.approvalQueue.map((p) => p.id)).toEqual(['a', 'b']);
    expect(result.current.approvalQueue[0].type).toBe('bandit:permission');
  });

  it('enqueueApproval is dedup-by-id (a re-send of the same id is a no-op)', () => {
    const { result } = renderHook(() => useApprovalQueue());
    act(() => {
      result.current.enqueueApproval(baseRequest('a'));
    });
    const firstQueue = result.current.approvalQueue;
    act(() => {
      result.current.enqueueApproval(baseRequest('a'));
    });
    // Same array reference — React skips the update.
    expect(result.current.approvalQueue).toBe(firstQueue);
    expect(result.current.approvalQueue).toHaveLength(1);
  });

  it('forwards optional fields (bodyPreview / risk / warning / diffStats / command / paramsPreview)', () => {
    const { result } = renderHook(() => useApprovalQueue());
    act(() => {
      result.current.enqueueApproval({
        ...baseRequest('a'),
        bodyPreview: 'patch preview',
        risk: 'medium',
        warning: 'ack',
        diffStats: { added: 3, removed: 1 },
        command: 'echo hi',
        paramsPreview: '{ "path": "foo" }'
      });
    });
    expect(result.current.approvalQueue[0]).toMatchObject({
      bodyPreview: 'patch preview',
      risk: 'medium',
      warning: 'ack',
      diffStats: { added: 3, removed: 1 },
      command: 'echo hi',
      paramsPreview: '{ "path": "foo" }'
    });
  });

  it('handleApprovalChoice pops the head and posts the permissionResponse wire message', () => {
    const { result } = renderHook(() => useApprovalQueue());
    act(() => {
      result.current.enqueueApproval(baseRequest('a'));
      result.current.enqueueApproval(baseRequest('b'));
    });
    act(() => {
      result.current.handleApprovalChoice('a', 'allow', 'looks-fine');
    });
    expect(result.current.approvalQueue.map((p) => p.id)).toEqual(['b']);
    expect(recorder.calls).toEqual([
      { type: 'permissionResponse', id: 'a', choice: 'allow', notes: 'looks-fine' }
    ]);
  });

  it('resolveApproval drops the matching entry (covers the network-resume cleanup)', () => {
    const { result } = renderHook(() => useApprovalQueue());
    act(() => {
      result.current.enqueueApproval(baseRequest('a'));
      result.current.enqueueApproval(baseRequest('b'));
    });
    act(() => {
      result.current.resolveApproval('a');
    });
    expect(result.current.approvalQueue.map((p) => p.id)).toEqual(['b']);
    // No outbound message — resolveApproval is the inbound dispatch's
    // cleanup, not a user choice.
    expect(recorder.calls).toEqual([]);
  });

  it('resolveApproval for an unknown id is a no-op (no crash)', () => {
    const { result } = renderHook(() => useApprovalQueue());
    act(() => {
      result.current.enqueueApproval(baseRequest('a'));
    });
    act(() => {
      result.current.resolveApproval('never-queued');
    });
    expect(result.current.approvalQueue.map((p) => p.id)).toEqual(['a']);
  });
});
