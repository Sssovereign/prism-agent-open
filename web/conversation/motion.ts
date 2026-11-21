// Source: ZCode v4/ConversationUserInputBody.tsx and components/ui/collapsible.tsx.
export const USER_INPUT_COLLAPSED_HEIGHT = 120;
export const DISCLOSURE_DURATION_MS = 300;
export const DISCLOSURE_EASING = 'cubic-bezier(0.4, 0, 0.2, 1)';
export const userInputOverflows = (height: number) => height > USER_INPUT_COLLAPSED_HEIGHT + 1;
export const userInputMaxHeight = (expanded: boolean, height: number) =>
  `${expanded ? Math.max(height, USER_INPUT_COLLAPSED_HEIGHT) : USER_INPUT_COLLAPSED_HEIGHT}px`;

/** Automatic default changes are not user choices. Keep explicit choices across completion/replay. */
export const resolveHistoryOpen = (defaultOpen: boolean, userChoice?: boolean) => userChoice ?? defaultOpen;

// ToolLayout.tsx persists only UI expansion, keyed by tool identity. Scope it to the session owner
// here so virtual remounts retain the choice without persisting conversation content to storage.
const disclosureChoices = new WeakMap<object, Map<string, boolean>>();
export function readDisclosureChoice(owner: object, key: string): boolean | undefined {
  return disclosureChoices.get(owner)?.get(key);
}
export function saveDisclosureChoice(owner: object, key: string, open: boolean): void {
  let choices = disclosureChoices.get(owner);
  if (!choices) disclosureChoices.set(owner, choices = new Map());
  choices.set(key, open);
}

// ToolCallBlocks.tsx uses stable tool IDs to prevent replay on virtual remount.
// Seed the current snapshot once: restoring history is never a live entrance.
const seenTools = new WeakMap<object, Set<string>>();
export function claimToolEntrance(owner: object, key: string, existing: readonly string[], active: boolean): boolean {
  let seen = seenTools.get(owner);
  if (!seen) { seen = new Set(existing); seenTools.set(owner, seen); }
  const fresh = !seen.has(key);
  seen.add(key);
  return active && fresh;
}
