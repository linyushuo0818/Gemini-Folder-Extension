import { ChatRef, StoredState } from './types';

export const STORAGE_KEY = 'gemini_projects_v1';
export const CURRENT_SCHEMA_VERSION = 1;

export function createEmptyState(): StoredState {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projects: [],
    chatIndex: {},
    uiPrefs: { projectsCollapsed: false }
  };
}

export function migrateState(raw: unknown): StoredState {
  if (!raw || typeof raw !== 'object') {
    return createEmptyState();
  }

  const candidate = raw as Partial<StoredState>;
  if (candidate.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    return createEmptyState();
  }

  const projects = Array.isArray(candidate.projects) ? candidate.projects : [];
  const rawChatIndex =
    candidate.chatIndex && typeof candidate.chatIndex === 'object'
      ? (candidate.chatIndex as Record<string, ChatRef & { lastSeenAt?: number; lastUrl?: string }>)
      : {};
  const chatIndex: Record<string, ChatRef> = {};

  const normalizeStoredTitle = (title: string): { title: string; isPinned: boolean } => {
    const source = (title || '').trim();
    if (!source) return { title: '', isPinned: false };

    const hasPinnedToken = /(?:\bpinned\b|已置顶|置顶)/i.test(source);
    const cleaned = source
      .replace(/\s*(?:[-–—|·•]?\s*)?(?:pinned)(?:\.{3}|…)?\s*$/i, '')
      .replace(/\s*(?:[-–—|·•]?\s*)?(?:已置顶|置顶)(?:\.{3}|…)?\s*$/i, '')
      .trim();

    return {
      title: cleaned || source,
      isPinned: hasPinnedToken
    };
  };

  Object.entries(rawChatIndex).forEach(([key, value]) => {
    if (!value || typeof value !== 'object') return;
    const conversationId = value.conversationId || key;
    const normalized = normalizeStoredTitle(value.title || '');
    chatIndex[conversationId] = {
      conversationId,
      title: normalized.title,
      isPinned: typeof value.isPinned === 'boolean' ? value.isPinned : normalized.isPinned,
      projectId: value.projectId ?? null,
      updatedAt:
        typeof value.updatedAt === 'number'
          ? value.updatedAt
          : typeof value.lastSeenAt === 'number'
            ? value.lastSeenAt
            : Date.now(),
      lastUrl: typeof value.lastUrl === 'string' ? value.lastUrl : undefined
    };
  });

  const uiPrefs = candidate.uiPrefs || { projectsCollapsed: false };

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projects,
    chatIndex,
    uiPrefs
  };
}

export async function loadState(): Promise<StoredState> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return migrateState(result[STORAGE_KEY]);
}

export async function saveState(state: StoredState): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}
