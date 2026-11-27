import {
  BackgroundRequest,
  BackgroundResponse,
  ChatRef,
  DEFAULT_PROJECT_ICON_STYLE,
  NativeChatMetadata,
  Project,
  StoredState
} from '../shared/types';
import {
  createEmptyState,
  isProjectIconStyle,
  isSafeId,
  normalizeChatUrl,
  normalizeProjectsState,
  STORAGE_KEY
} from '../shared/storage';
import { createSeedData, normalizePromptsData, PROMPTS_KEY, PromptsData } from '../shared/prompts';
import { validateBackup } from '../shared/backup';
import { CloudSyncManager, StorageAreaLike } from './cloudSync';

export interface BackgroundServiceDeps {
  local: StorageAreaLike;
  sync: StorageAreaLike | null;
  now?: () => number;
  randomUUID?: () => string;
  debounceMs?: number;
}

export interface BackgroundService {
  handleMessage: (message: BackgroundRequest) => Promise<BackgroundResponse>;
  handleSyncChanged: (changes: Record<string, chrome.storage.StorageChange>) => Promise<void>;
  initialize: () => Promise<void>;
  dispose: () => void;
}

export function createBackgroundService(deps: BackgroundServiceDeps): BackgroundService {
  const clockNow = deps.now ?? (() => Date.now());
  const generateId = deps.randomUUID ?? (() => crypto.randomUUID());

  let cachedState: StoredState | null = null;
  let cachedPrompts: PromptsData | null = null;
  let mutationTail: Promise<void> = Promise.resolve();

  // 串行化写入，避免多标签页或高频同步消息并发覆盖状态。
  function runSerialized<T>(task: () => Promise<T>): Promise<T> {
    const next = mutationTail.then(task, task);
    mutationTail = next.then(() => undefined, () => undefined);
    return next;
  }

  async function readRawLocalSnapshot() {
    const raw = await deps.local.get([STORAGE_KEY, PROMPTS_KEY]);
    const hasLocalProjects = raw[STORAGE_KEY] !== undefined;
    const hasLocalPrompts = raw[PROMPTS_KEY] !== undefined;

    let state: StoredState;
    if (cachedState) {
      state = cachedState;
    } else if (!hasLocalProjects) {
      state = createEmptyState();
    } else {
      const normalized = normalizeProjectsState(raw[STORAGE_KEY]);
      if (!normalized) throw new Error('Could not read projects data.');
      state = normalized;
      cachedState = state;
    }

    let prompts: PromptsData;
    if (cachedPrompts) {
      prompts = cachedPrompts;
    } else if (!hasLocalPrompts) {
      prompts = { prompts: {}, version: 1 };
    } else {
      const normalized = normalizePromptsData(raw[PROMPTS_KEY]);
      if (!normalized) throw new Error('Could not read prompts. Please try again.');
      prompts = normalized;
      cachedPrompts = prompts;
    }

    return { hasLocalProjects, hasLocalPrompts, state, prompts };
  }

  async function applyPulledData(next: { state?: StoredState; prompts?: PromptsData }): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (next.state) patch[STORAGE_KEY] = next.state;
    if (next.prompts) patch[PROMPTS_KEY] = next.prompts;
    if (Object.keys(patch).length === 0) return;
    await deps.local.set(patch);
    if (next.state) cachedState = next.state;
    if (next.prompts) cachedPrompts = next.prompts;
  }

  const cloudSync = new CloudSyncManager({
    local: deps.local,
    sync: deps.sync,
    hooks: {
      readRawLocalSnapshot,
      applyPulledData,
      runSerialized
    },
    now: clockNow,
    randomUUID: generateId,
    debounceMs: deps.debounceMs
  });

  async function loadLocalState(): Promise<StoredState> {
    if (cachedState) return cachedState;
    const raw = (await deps.local.get(STORAGE_KEY))[STORAGE_KEY];
    if (raw === undefined) {
      cachedState = createEmptyState();
      return cachedState;
    }
    const normalized = normalizeProjectsState(raw);
    if (!normalized) throw new Error('Could not read projects data.');
    cachedState = normalized;
    return cachedState;
  }

  async function loadLocalPromptsRaw(): Promise<PromptsData | null> {
    if (cachedPrompts) return cachedPrompts;
    const raw = (await deps.local.get(PROMPTS_KEY))[PROMPTS_KEY];
    if (raw === undefined) return null;
    const normalized = normalizePromptsData(raw);
    if (!normalized) throw new Error('Could not read prompts. Please try again.');
    cachedPrompts = normalized;
    return cachedPrompts;
  }

  async function getState(): Promise<StoredState> {
    await cloudSync.ensureInitialized();
    return loadLocalState();
  }

  async function getPrompts(): Promise<PromptsData> {
    await cloudSync.ensureInitialized();
    const existing = await loadLocalPromptsRaw();
    if (existing) return existing;

    // 仅在本地与远端均未初始化时生成默认提示词，并立即同步，避免多端重复生成。
    const seeded = createSeedData();
    await deps.local.set({ [PROMPTS_KEY]: seeded });
    cachedPrompts = seeded;
    await cloudSync.pushCurrentState();
    return seeded;
  }

  async function commitState(nextState: StoredState): Promise<StoredState> {
    await deps.local.set({ [STORAGE_KEY]: nextState });
    cachedState = nextState;
    return nextState;
  }

  function buildUpsertProjectState(state: StoredState, project: Project, updatedAt: number): StoredState {
    const exists = state.projects.some((item) => item.id === project.id);
    const projects = exists
      ? state.projects.map((item) =>
          item.id === project.id
            ? {
                ...item,
                name: project.name,
                icon: project.icon,
                iconStyle: project.iconStyle ?? item.iconStyle,
                color: project.color,
                useIconPalette: project.useIconPalette,
                updatedAt
              }
            : item
        )
      : [...state.projects, { ...project, iconStyle: project.iconStyle ?? DEFAULT_PROJECT_ICON_STYLE, updatedAt }];
    return { ...state, projects };
  }

  function buildDeleteProjectState(state: StoredState, projectId: string): StoredState {
    const projects = state.projects.filter((item) => item.id !== projectId);
    const chatIndex: Record<string, ChatRef> = {};
    for (const [key, chat] of Object.entries(state.chatIndex)) {
      chatIndex[key] = chat.projectId === projectId ? { ...chat, projectId: null } : chat;
    }
    return { ...state, projects, chatIndex };
  }

  function mergeNativeMetadata(existing: ChatRef | undefined, chat: NativeChatMetadata, now: number): ChatRef {
    // 原生历史扫描只拥有标题和 URL，项目归属由后台维护；已归属聊天标题或链接变更时刷新更新时间以触发防抖同步。
    const nextTitle = chat.title || existing?.title || '';
    const nextUrl = normalizeChatUrl(chat.lastUrl, chat.conversationId) ?? existing?.lastUrl;
    const metadataChanged = existing !== undefined && (existing.title !== nextTitle || existing.lastUrl !== nextUrl);
    return {
      conversationId: chat.conversationId,
      title: nextTitle,
      isPinned: existing?.isPinned ?? false,
      projectId: existing?.projectId ?? null,
      updatedAt: existing ? (existing.projectId && metadataChanged ? now : existing.updatedAt) : now,
      lastUrl: nextUrl
    };
  }

  function buildUpsertChatRefsState(
    state: StoredState,
    chats: NativeChatMetadata[],
    now: number
  ): { nextState: StoredState; assignedChanged: boolean } {
    const chatIndex: Record<string, ChatRef> = { ...state.chatIndex };
    let changed = false;
    let assignedChanged = false;
    for (const chat of chats) {
      if (!isSafeId(chat.conversationId)) continue;
      const existing = chatIndex[chat.conversationId];
      const next = mergeNativeMetadata(existing, chat, now);
      if (existing?.title === next.title && existing.lastUrl === next.lastUrl) continue;
      chatIndex[chat.conversationId] = next;
      changed = true;
      if (next.projectId) assignedChanged = true;
    }
    return { nextState: changed ? { ...state, chatIndex } : state, assignedChanged };
  }

  function buildUpdateUiPrefsState(state: StoredState, prefs: Partial<StoredState['uiPrefs']>): StoredState {
    return {
      ...state,
      uiPrefs: { projectsCollapsed: prefs.projectsCollapsed ?? state.uiPrefs.projectsCollapsed }
    };
  }

  async function handleMessage(message: BackgroundRequest): Promise<BackgroundResponse> {
    return runSerialized<BackgroundResponse>(async () => {
      switch (message.type) {
        case 'getSyncStatus': {
          await cloudSync.ensureInitialized();
          return { ok: true, syncStatus: await cloudSync.getStatus() };
        }
        case 'setSyncEnabled': {
          const result = await cloudSync.setEnabled(message.enabled);
          return result.ok
            ? { ok: true, syncStatus: result.status }
            : { ok: false, error: result.error ?? 'Could not update Chrome Sync.', syncStatus: result.status };
        }
        case 'syncNow': {
          const result = await cloudSync.syncNow();
          return result.ok
            ? { ok: true, syncStatus: result.status }
            : { ok: false, error: result.error ?? 'Sync failed.', syncStatus: result.status };
        }
        case 'restoreBackup': {
          await cloudSync.ensureInitialized();
          const { projects, prompts } = validateBackup(message.data);
          const prevState = await loadLocalState();
          const prevPrompts = await loadLocalPromptsRaw();
          const prepared = await cloudSync.prepareBackupRestore(prevState, prevPrompts, projects, prompts);
          await deps.local.set({
            ...(prepared.projects && { [STORAGE_KEY]: prepared.projects }),
            ...(prepared.prompts && { [PROMPTS_KEY]: prepared.prompts })
          });
          if (prepared.projects) cachedState = prepared.projects;
          if (prepared.prompts) cachedPrompts = prepared.prompts;
          await cloudSync.pushCurrentState();
          return { ok: true };
        }
        case 'getPrompts':
          return { ok: true, prompts: await getPrompts() };
        case 'savePrompt':
        case 'deletePrompt':
        case 'trackPromptUsage': {
          const current = await getPrompts();
          const prompts = { ...current.prompts };
          const id = message.type === 'savePrompt'
            ? message.prompt.id ?? generateId()
            : message.id;
          if (!isSafeId(id)) return { ok: false, error: 'Invalid prompt ID.' };
          const existing = prompts[id];
          const now = clockNow();
          if (message.type === 'savePrompt') {
            const { title, content } = message.prompt;
            if (!title.trim() || !content.trim()) return { ok: false, error: 'Name and content are required.' };
            if (message.prompt.id && !existing) return { ok: false, error: 'This prompt was removed in another tab.' };
            const baseNow = existing ? Math.max(now, existing.updatedAt + 1) : now;
            const updatedAt = await cloudSync.recordPromptAlive(id, baseNow);
            prompts[id] = {
              id,
              title,
              content,
              updatedAt,
              createdAt: existing?.createdAt ?? updatedAt,
              usageCount: existing?.usageCount ?? 0,
              lastUsedAt: existing?.lastUsedAt ?? 0
            };
          } else {
            if (!existing) return { ok: true };
            if (message.type === 'deletePrompt') {
              delete prompts[id];
              await cloudSync.recordPromptDeleted(id, existing.updatedAt);
            } else {
              prompts[id] = { ...existing, usageCount: existing.usageCount + 1, lastUsedAt: now };
            }
          }
          const next = { ...current, prompts };
          await deps.local.set({ [PROMPTS_KEY]: next });
          cachedPrompts = next;
          if (message.type !== 'trackPromptUsage') {
            await cloudSync.pushCurrentState();
          }
          return { ok: true };
        }
      }

      const state = await getState();
      switch (message.type) {
        case 'getState':
          return { ok: true, state };
        case 'upsertProject': {
          if (message.project.iconStyle !== undefined && !isProjectIconStyle(message.project.iconStyle)) {
            return { ok: false, error: 'Invalid project icon style.' };
          }
          const existingProject = state.projects.find((item) => item.id === message.project.id);
          if (message.editing && !existingProject) {
            return { ok: false, error: 'Project not found' };
          }
          const baseNow = existingProject ? Math.max(clockNow(), existingProject.updatedAt + 1) : clockNow();
          const updatedAt = await cloudSync.recordProjectAlive(message.project.id, baseNow);
          const nextState = await commitState(buildUpsertProjectState(state, message.project, updatedAt));
          await cloudSync.pushCurrentState();
          return { ok: true, state: nextState };
        }
        case 'setProjectPinned': {
          const project = state.projects.find((item) => item.id === message.projectId);
          if (!project) return { ok: false, error: 'Project not found' };
          const updatedAt = Math.max(clockNow(), project.updatedAt + 1);
          const nextState = await commitState({
            ...state,
            projects: state.projects.map((item) =>
              item.id === project.id
                ? { ...item, isPinned: message.isPinned, updatedAt }
                : item
            )
          });
          await cloudSync.pushCurrentState();
          return { ok: true, state: nextState };
        }
        case 'deleteProject': {
          const target = state.projects.find((item) => item.id === message.projectId);
          const nextState = await commitState(buildDeleteProjectState(state, message.projectId));
          if (target) {
            await cloudSync.recordProjectDeleted(message.projectId, target.updatedAt);
            await cloudSync.pushCurrentState();
          }
          return { ok: true, state: nextState };
        }
        case 'moveChat': {
          const { conversationId, projectId, metadata } = message;
          if (!isSafeId(conversationId) ||
              (projectId !== null && !state.projects.some((item) => item.id === projectId))) {
            return { ok: false, error: 'Chat or destination project is unavailable.' };
          }
          const now = clockNow();
          const existing = state.chatIndex[conversationId];
          const chat = mergeNativeMetadata(
            existing,
            metadata ? { ...metadata, conversationId } : { conversationId, title: '' },
            now
          );
          if (!existing && !chat.lastUrl) return { ok: false, error: 'Chat is unavailable.' };

          let updatedAt = now;
          if (projectId === null) {
            if (existing?.projectId) {
              updatedAt = Math.max(now, existing.updatedAt);
              await cloudSync.recordChatUnassigned(conversationId, updatedAt);
            }
          } else {
            const baseNow = existing ? Math.max(now, existing.updatedAt + 1) : now;
            updatedAt = await cloudSync.recordChatAssigned(conversationId, baseNow);
          }

          const nextState = await commitState({
            ...state,
            chatIndex: {
              ...state.chatIndex,
              [conversationId]: { ...chat, projectId, updatedAt }
            }
          });
          await cloudSync.pushCurrentState();
          return { ok: true, state: nextState };
        }
        case 'upsertChatRefs': {
          const { nextState, assignedChanged } = buildUpsertChatRefsState(state, message.chats, clockNow());
          const committed = nextState === state ? state : await commitState(nextState);
          if (assignedChanged) {
            cloudSync.scheduleDebouncedPush();
          }
          return { ok: true, state: committed };
        }
        case 'updateUiPrefs': {
          const nextState = await commitState(buildUpdateUiPrefsState(state, message.prefs));
          return { ok: true, state: nextState };
        }
        default:
          return { ok: false, error: 'Unknown message type' };
      }
    });
  }

  return {
    handleMessage,
    handleSyncChanged: (changes) => runSerialized(() => cloudSync.handleSyncChanged(changes)),
    initialize: () => runSerialized(() => cloudSync.ensureInitialized()),
    dispose: () => cloudSync.dispose()
  };
}
