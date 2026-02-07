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
  Object.entries(rawChatIndex).forEach(([key, value]) => {
    if (!value || typeof value !== 'object') return;
    const conversationId = value.conversationId || key;
    chatIndex[conversationId] = {
      conversationId,
      title: value.title || '',
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

