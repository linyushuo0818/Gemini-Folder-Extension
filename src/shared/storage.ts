import { ChatRef, DEFAULT_PROJECT_ICON_STYLE, Project, ProjectIcon, ProjectIconStyle, PROJECT_ICONS, PROJECT_ICON_STYLES, StoredState } from './types';
import { storageLocalGet, storageLocalSet } from './webext';

export const STORAGE_KEY = 'gemini_projects_v1';
export const CURRENT_SCHEMA_VERSION = 1;

const PROJECT_ICON_SET = new Set<string>(PROJECT_ICONS);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9_-]{1,128}$/i.test(value) && !(value in Object.prototype);
}

export function isProjectColor(value: unknown): value is string {
  return typeof value === 'string' && /^#(?:[a-f0-9]{3,4}|[a-f0-9]{6}|[a-f0-9]{8})$/i.test(value);
}

export function isProjectIcon(value: unknown): value is ProjectIcon {
  return typeof value === 'string' && PROJECT_ICON_SET.has(value);
}

export function isProjectIconStyle(value: unknown): value is ProjectIconStyle {
  return PROJECT_ICON_STYLES.some((style) => style === value);
}

export function normalizeChatUrl(value: unknown, conversationId: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const origin = 'https://gemini.google.com';
    const url = new URL(value, origin);
    const path = /^\/(?:u\/\d+\/)?app\/([a-z0-9_-]+)\/?$/i.exec(url.pathname);
    if (url.origin === origin && !url.username && !url.password && path?.[1] === conversationId) {
      return url.href;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

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

export function sanitizeProject(
  raw: unknown,
  fallbackIndex: number,
  fallbackIconStyle: ProjectIconStyle,
  strict: boolean
): Project | null {
  if (!isRecord(raw)) return null;
  const candidate = raw as Partial<Project>;
  if (!isSafeId(candidate.id)) return null;
  if (typeof candidate.name !== 'string' || !candidate.name.trim()) return null;
  const iconStyle = candidate.iconStyle;
  const validIconStyle = isProjectIconStyle(iconStyle);
  if (strict && iconStyle !== undefined && !validIconStyle) return null;

  const now = Date.now();
  return {
    id: candidate.id,
    name: candidate.name.trim(),
    icon: isProjectIcon(candidate.icon) ? candidate.icon : 'default',
    iconStyle: validIconStyle ? iconStyle : fallbackIconStyle,
    color: isProjectColor(candidate.color) ? candidate.color : undefined,
    useIconPalette: candidate.useIconPalette === true || undefined,
    isPinned: candidate.isPinned === true,
    createdAt: typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt) ? candidate.createdAt : now,
    updatedAt: typeof candidate.updatedAt === 'number' && Number.isFinite(candidate.updatedAt) ? candidate.updatedAt : now,
    sortIndex: typeof candidate.sortIndex === 'number' && Number.isFinite(candidate.sortIndex) ? candidate.sortIndex : fallbackIndex
  };
}

// 校验并规范化外部或持久化来源的项目状态；结构不合法时返回 null。
export function normalizeProjectsState(raw: unknown, strict = false): StoredState | null {
  if (!isRecord(raw) || raw.schemaVersion !== CURRENT_SCHEMA_VERSION ||
      !Array.isArray(raw.projects) || !isRecord(raw.chatIndex) ||
      (raw.uiPrefs !== undefined && !isRecord(raw.uiPrefs))) return null;

  // 旧数据只有全局样式，使用它补齐各项目缺失的样式。
  const legacyIconStyle = raw.uiPrefs?.projectIconStyle;
  const validLegacyIconStyle = isProjectIconStyle(legacyIconStyle);
  if (strict && legacyIconStyle !== undefined && !validLegacyIconStyle) return null;
  const fallbackIconStyle = validLegacyIconStyle ? legacyIconStyle : DEFAULT_PROJECT_ICON_STYLE;

  const projects: Project[] = [];
  const projectIds = new Set<string>();
  for (const entry of raw.projects) {
    const project = sanitizeProject(entry, projects.length, fallbackIconStyle, strict);
    if (!project || projectIds.has(project.id) ||
        (strict && entry.color != null && !isProjectColor(entry.color))) {
      if (strict) return null;
      continue;
    }
    projects.push(project);
    projectIds.add(project.id);
  }

  const chatIndex: Record<string, ChatRef> = {};
  for (const [key, value] of Object.entries(raw.chatIndex)) {
    if (!isRecord(value)) {
      if (strict) return null;
      continue;
    }
    const conversationId = value.conversationId ?? key;
    if (!isSafeId(conversationId) || !isSafeId(key) || Object.hasOwn(chatIndex, conversationId)) {
      if (strict) return null;
      continue;
    }
    const projectId = typeof value.projectId === 'string' && projectIds.has(value.projectId)
      ? value.projectId : null;
    const lastUrl = normalizeChatUrl(value.lastUrl, conversationId);
    if (strict && ((value.projectId != null && !projectId) || (value.lastUrl != null && !lastUrl))) return null;
    const normalized = normalizeStoredTitle(typeof value.title === 'string' ? value.title : '');
    chatIndex[conversationId] = {
      conversationId,
      title: normalized.title,
      isPinned: typeof value.isPinned === 'boolean' ? value.isPinned : normalized.isPinned,
      projectId,
      updatedAt:
        typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
          ? value.updatedAt
          : typeof value.lastSeenAt === 'number' && Number.isFinite(value.lastSeenAt)
            ? value.lastSeenAt
            : Date.now(),
      lastUrl
    };
  }

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projects,
    chatIndex,
    uiPrefs: { projectsCollapsed: raw.uiPrefs?.projectsCollapsed === true }
  };
}

export async function loadState(): Promise<StoredState> {
  const result = await storageLocalGet<Record<string, unknown>>(STORAGE_KEY);
  const raw = result[STORAGE_KEY];
  if (raw === undefined) return createEmptyState();
  const state = normalizeProjectsState(raw);
  if (!state) throw new Error('Could not read projects data.');
  return state;
}

export async function saveState(state: StoredState): Promise<void> {
  await storageLocalSet({ [STORAGE_KEY]: state });
}
