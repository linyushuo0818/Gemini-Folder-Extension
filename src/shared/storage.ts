import { ChatRef, Project, ProjectIcon, StoredState } from './types';
import { storageLocalGet, storageLocalSet } from './webext';

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

function normalizeStoredTitle(title: string): { title: string; isPinned: boolean } {
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
}

function sanitizeProject(raw: unknown, fallbackIndex: number): Project | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Partial<Project>;
  if (typeof candidate.id !== 'string' || !candidate.id.trim()) return null;
  if (typeof candidate.name !== 'string' || !candidate.name.trim()) return null;

  const now = Date.now();
  return {
    id: candidate.id,
    name: candidate.name.trim(),
    icon: (typeof candidate.icon === 'string' && candidate.icon ? candidate.icon : 'default') as ProjectIcon,
    color: typeof candidate.color === 'string' && candidate.color ? candidate.color : undefined,
    isPinned: candidate.isPinned === true,
    createdAt: typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt) ? candidate.createdAt : now,
    updatedAt: typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt) ? candidate.updatedAt : now,
    sortIndex: typeof candidate.sortIndex === 'number' && Number.isFinite(candidate.sortIndex) ? candidate.sortIndex : fallbackIndex
  };
}

// 校验并规范化外部或持久化来源的项目状态；结构不合法时返回 null。
export function normalizeProjectsState(raw: unknown): StoredState | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const candidate = raw as Partial<StoredState>;
  if (candidate.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    return null;
  }

  const projects: Project[] = Array.isArray(candidate.projects)
    ? candidate.projects
        .map((item, idx) => sanitizeProject(item, idx))
        .filter((item): item is Project => item !== null)
    : [];

  const rawChatIndex =
    candidate.chatIndex && typeof candidate.chatIndex === 'object' && !Array.isArray(candidate.chatIndex)
      ? (candidate.chatIndex as Record<string, ChatRef & { lastSeenAt?: number; lastUrl?: string }>)
      : {};
  const chatIndex: Record<string, ChatRef> = {};

  Object.entries(rawChatIndex).forEach(([key, value]) => {
    if (!value || typeof value !== 'object') return;
    const conversationId = typeof value.conversationId === 'string' && value.conversationId ? value.conversationId : key;
    if (!conversationId) return;
    const normalized = normalizeStoredTitle(typeof value.title === 'string' ? value.title : '');
    chatIndex[conversationId] = {
      conversationId,
      title: normalized.title,
      isPinned: typeof value.isPinned === 'boolean' ? value.isPinned : normalized.isPinned,
      projectId: typeof value.projectId === 'string' ? value.projectId : null,
      updatedAt:
        typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
          ? value.updatedAt
          : typeof value.lastSeenAt === 'number' && Number.isFinite(value.lastSeenAt)
            ? value.lastSeenAt
            : Date.now(),
      lastUrl: typeof value.lastUrl === 'string' ? value.lastUrl : undefined
    };
  });

  const uiPrefs = {
    projectsCollapsed: candidate.uiPrefs?.projectsCollapsed === true
  };

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projects,
    chatIndex,
    uiPrefs
  };
}

export function migrateState(raw: unknown): StoredState {
  return normalizeProjectsState(raw) ?? createEmptyState();
}

export async function loadState(): Promise<StoredState> {
  const result = await storageLocalGet<Record<string, unknown>>(STORAGE_KEY);
  return migrateState(result[STORAGE_KEY]);
}

export async function saveState(state: StoredState): Promise<void> {
  await storageLocalSet({ [STORAGE_KEY]: state });
}
