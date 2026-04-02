/**
 * Approval flow for outbound messages to external contacts.
 * Intercepts "send", "cancel", "edit: ..." commands in the main chat.
 */

import {
  createBotThread,
  getPendingApprovals,
  getPendingApprovalById,
  updateApprovalStatus,
  expireOldApprovals,
} from './db.js';
import { logger } from './logger.js';

export interface ApprovalAction {
  type: 'send' | 'send_all' | 'send_ids' | 'cancel' | 'edit' | 'none';
  ids?: number[];
  editText?: string;
}

/**
 * Parse a message to see if it's an approval command.
 * Returns the action type, or 'none' if it's not an approval command.
 */
export function parseApprovalCommand(text: string): ApprovalAction {
  const trimmed = text.trim().toLowerCase();

  if (trimmed === 'send' || trimmed === 'send it' || trimmed === 'approve') {
    return { type: 'send' };
  }

  if (trimmed === 'send all' || trimmed === 'approve all') {
    return { type: 'send_all' };
  }

  if (trimmed === 'cancel' || trimmed === 'discard') {
    return { type: 'cancel' };
  }

  // "send 1, 3, 5" — specific IDs
  const sendIdsMatch = trimmed.match(/^send\s+([\d,\s]+)$/);
  if (sendIdsMatch) {
    const ids = sendIdsMatch[1]
      .split(/[,\s]+/)
      .map((s) => parseInt(s, 10))
      .filter((n) => !isNaN(n));
    if (ids.length > 0) return { type: 'send_ids', ids };
  }

  // "edit: ..." — revision request
  const editMatch = text.trim().match(/^edit:\s*(.+)$/is);
  if (editMatch) {
    return { type: 'edit', editText: editMatch[1].trim() };
  }

  return { type: 'none' };
}

/**
 * Check if there are any pending approvals.
 */
export function hasPendingApprovals(): boolean {
  return getPendingApprovals().length > 0;
}

/**
 * Process an approval command. Returns a response message for the user,
 * and an array of approved messages to send.
 */
export function processApproval(action: ApprovalAction): {
  response: string;
  toSend: Array<{
    id: number;
    channel: string;
    recipient: string;
    content: string;
    subject: string | null;
  }>;
  editApprovalId?: number;
} {
  const pending = getPendingApprovals();

  if (pending.length === 0) {
    return { response: 'No pending drafts to approve.', toSend: [] };
  }

  const toSend: Array<{
    id: number;
    channel: string;
    recipient: string;
    content: string;
    subject: string | null;
  }> = [];

  if (action.type === 'send') {
    // Approve the most recent pending draft
    const approval = pending[0];
    const meta = approval.metadata ? JSON.parse(approval.metadata) : {};
    updateApprovalStatus(approval.id, 'approved');
    toSend.push({
      id: approval.id,
      channel: approval.channel,
      recipient: approval.recipient,
      content: approval.content,
      subject: meta.subject || null,
    });
    return {
      response: `Sending to ${approval.recipient} via ${approval.channel}.`,
      toSend,
    };
  }

  if (action.type === 'send_all') {
    for (const approval of pending) {
      const meta = approval.metadata ? JSON.parse(approval.metadata) : {};
      updateApprovalStatus(approval.id, 'approved');
      toSend.push({
        id: approval.id,
        channel: approval.channel,
        recipient: approval.recipient,
        content: approval.content,
        subject: meta.subject || null,
      });
    }
    return {
      response: `Sending ${toSend.length} message(s).`,
      toSend,
    };
  }

  if (action.type === 'send_ids' && action.ids) {
    for (const id of action.ids) {
      const approval = getPendingApprovalById(id);
      if (approval && approval.status === 'pending') {
        const meta = approval.metadata ? JSON.parse(approval.metadata) : {};
        updateApprovalStatus(approval.id, 'approved');
        toSend.push({
          id: approval.id,
          channel: approval.channel,
          recipient: approval.recipient,
          content: approval.content,
          subject: meta.subject || null,
        });
      }
    }
    if (toSend.length === 0) {
      return { response: 'No matching pending drafts found.', toSend: [] };
    }
    return {
      response: `Sending ${toSend.length} message(s).`,
      toSend,
    };
  }

  if (action.type === 'cancel') {
    // Cancel the most recent pending draft
    const approval = pending[0];
    updateApprovalStatus(approval.id, 'cancelled');
    return {
      response: `Draft #${approval.id} to ${approval.recipient} cancelled.`,
      toSend: [],
    };
  }

  if (action.type === 'edit') {
    // Return the most recent pending draft's ID so the agent can revise
    const approval = pending[0];
    return {
      response: `Edit requested for draft #${approval.id}. Revision: "${action.editText}"`,
      toSend: [],
      editApprovalId: approval.id,
    };
  }

  return { response: '', toSend: [] };
}

/**
 * After sending an approved message, create a bot_thread entry for tracking.
 */
export function trackSentMessage(
  channel: string,
  threadId: string,
  recipient: string,
  subject: string | null,
): number {
  return createBotThread({
    channel,
    thread_id: threadId,
    recipient,
    subject,
    status: 'active',
    created_at: new Date().toISOString(),
  });
}

/**
 * Expire old pending approvals (default: 24 hours).
 * Call this periodically from the scheduler.
 */
export function cleanupExpiredApprovals(): void {
  const expired = expireOldApprovals(24);
  if (expired > 0) {
    logger.info({ count: expired }, 'Expired old pending approvals');
  }
}
