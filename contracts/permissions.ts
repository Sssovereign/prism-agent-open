/** Approval mode controls operation confirmation; local file access follows host account permissions. */
export type ApprovalMode = 'ask' | 'auto' | 'full';
export const APPROVAL_MODES: readonly ApprovalMode[] = ['ask','auto','full'];
export function isApprovalMode(value: unknown): value is ApprovalMode {
 return typeof value==='string' && APPROVAL_MODES.includes(value as ApprovalMode);
}
