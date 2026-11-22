// 块E5：输入历史——逐值移植 ZCode a9fe401 lib/promptHistory.ts 与 lib/promptHistoryStorage.ts。
// 上游按 workspacePath 持久化到 localStorage；本项目以 projectId 作为工作区键。

export const MAX_PROMPT_HISTORY = 30;

type PromptHistoryDirection = 'up' | 'down';

export interface PromptHistoryNavigationResult {
  nextIndex: number | null;
  nextValue: string;
  shouldHandle: boolean;
}

export function appendPromptHistoryEntry(
  entries: readonly string[],
  entry: string,
  limit = MAX_PROMPT_HISTORY,
): string[] {
  const trimmed = entry.trim();
  if (!trimmed) {
    return [...entries];
  }
  // 只比较 trim 后的最后一条，避免误删 A、B、A 这类非连续重复历史。
  if (entries.at(-1)?.trim() === trimmed) {
    return [...entries];
  }
  const normalizedLimit = Math.max(1, Math.trunc(limit));
  return [...entries, trimmed].slice(-normalizedLimit);
}

export function navigatePromptHistory(
  entries: readonly string[],
  currentIndex: number | null,
  direction: PromptHistoryDirection,
): PromptHistoryNavigationResult {
  if (entries.length === 0) {
    return { nextIndex: currentIndex, nextValue: '', shouldHandle: false };
  }
  if (direction === 'up') {
    const nextIndex = currentIndex === null ? entries.length - 1 : Math.max(currentIndex - 1, 0);
    return { nextIndex, nextValue: entries[nextIndex] ?? '', shouldHandle: true };
  }
  if (currentIndex === null) {
    const nextIndex = entries.length - 1;
    return { nextIndex, nextValue: entries[nextIndex] ?? '', shouldHandle: true };
  }
  if (currentIndex >= entries.length - 1) {
    return { nextIndex: null, nextValue: '', shouldHandle: true };
  }
  const nextIndex = currentIndex + 1;
  return { nextIndex, nextValue: entries[nextIndex] ?? '', shouldHandle: true };
}

// —— promptHistoryStorage —— 

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const PROMPT_HISTORY_STORAGE_KEY_PREFIX = 'prism-prompt-history:';

function getBrowserStorage(): StorageLike | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getPromptHistoryStorageKey(workspaceKey: string): string {
  return `${PROMPT_HISTORY_STORAGE_KEY_PREFIX}${workspaceKey}`;
}

function normalizePromptHistoryEntries(entries: readonly unknown[]): string[] {
  return entries
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(-MAX_PROMPT_HISTORY);
}

export function readPromptHistoryEntries(
  workspaceKey: string,
  storage: StorageLike | null = getBrowserStorage(),
): string[] {
  let rawValue: string | null | undefined;
  try { rawValue=storage?.getItem(getPromptHistoryStorageKey(workspaceKey)); } catch { return []; }
  if (!rawValue) {
    return [];
  }
  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return normalizePromptHistoryEntries(parsed);
  } catch {
    return [];
  }
}

export function persistPromptHistoryEntries(
  workspaceKey: string,
  entries: readonly string[],
  storage: StorageLike | null = getBrowserStorage(),
): void {
  // 刷新页面/重开窗口后上键仍能拿到刚发过的消息；按项目隔离避免串历史。
  try { storage?.setItem(getPromptHistoryStorageKey(workspaceKey), JSON.stringify(normalizePromptHistoryEntries(entries))); } catch { /* optional local preference */ }
}
