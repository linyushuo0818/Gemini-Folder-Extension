import { BackgroundRequest, BackgroundResponse, ChatRef, Project, StoredState } from './shared/types';
import { createEmptyState, loadState, migrateState, saveState, STORAGE_KEY } from './shared/storage';
import { webext } from './shared/webext';

let cachedState: StoredState | null = null;
let loadPromise: Promise<StoredState> | null = null;
let mutationTail: Promise<void> = Promise.resolve();

async function getState(): Promise<StoredState> {
  if (cachedState) {
    return cachedState;
  }
  if (!loadPromise) {
    loadPromise = loadState()
      .catch(() => createEmptyState())
      .finally(() => {
        loadPromise = null;
      });
  }
  cachedState = await loadPromise;
  return cachedState;
}

// 串行化写入，避免多标签页或高频同步消息并发覆盖状态。
function runSerialized<T>(task: () => Promise<T>): Promise<T> {
  const next = mutationTail.then(task, task);
  mutationTail = next.then(() => undefined, () => undefined);
  return next;
}

async function commitState(nextState: StoredState): Promise<StoredState> {
  await saveState(nextState);
  cachedState = nextState;
  return nextState;
}

function buildUpsertProjectState(state: StoredState, project: Project): StoredState {
  const exists = state.projects.some((item) => item.id === project.id);
  const projects = exists
    ? state.projects.map((item) =>
        item.id === project.id
          ? { ...item, ...project, updatedAt: project.updatedAt ?? Date.now() }
          : item
      )
    : [...state.projects, project];
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

function buildMoveChatState(state: StoredState, conversationId: string, projectId: string | null): StoredState {
  const existing = state.chatIndex[conversationId];
  return {
    ...state,
    chatIndex: {
      ...state.chatIndex,
      [conversationId]: {
        conversationId,
        title: existing?.title ?? '',
        isPinned: existing?.isPinned ?? false,
        projectId,
        updatedAt: Date.now(),
        lastUrl: existing?.lastUrl
      }
    }
  };
}

function buildUpsertChatRefsState(state: StoredState, chats: ChatRef[]): StoredState {
  const chatIndex: Record<string, ChatRef> = { ...state.chatIndex };
  for (const chat of chats) {
    const existing = chatIndex[chat.conversationId];
    chatIndex[chat.conversationId] = {
      conversationId: chat.conversationId,
      title: chat.title || existing?.title || '',
      isPinned: typeof chat.isPinned === 'boolean' ? chat.isPinned : (existing?.isPinned ?? false),
      projectId: chat.projectId ?? existing?.projectId ?? null,
      updatedAt: chat.updatedAt ?? existing?.updatedAt ?? Date.now(),
      lastUrl: chat.lastUrl ?? existing?.lastUrl
    };
  }
  return { ...state, chatIndex };
}

function buildUpdateUiPrefsState(state: StoredState, prefs: Partial<StoredState['uiPrefs']>): StoredState {
  return {
    ...state,
    uiPrefs: { ...state.uiPrefs, ...prefs }
  };
}

async function handleMessage(message: BackgroundRequest): Promise<BackgroundResponse> {
  if (message.type === 'getState') {
    const state = await getState();
    return { ok: true, state };
  }

  return runSerialized<BackgroundResponse>(async () => {
    if (message.type === 'refreshStateCache') {
      cachedState = await loadState().catch(() => createEmptyState());
      return { ok: true, state: cachedState };
    }

    const state = await getState();

    switch (message.type) {
      case 'upsertProject': {
        const nextState = await commitState(buildUpsertProjectState(state, message.project));
        return { ok: true, state: nextState };
      }
      case 'setProjectPinned': {
        const project = state.projects.find((item) => item.id === message.projectId);
        if (!project) return { ok: false, error: 'Project not found' };
        const nextState = await commitState({
          ...state,
          projects: state.projects.map((item) =>
            item.id === project.id
              ? { ...item, isPinned: message.isPinned, updatedAt: Date.now() }
              : item
          )
        });
        return { ok: true, state: nextState };
      }
      case 'deleteProject': {
        const nextState = await commitState(buildDeleteProjectState(state, message.projectId));
        return { ok: true, state: nextState };
      }
      case 'moveChat': {
        const nextState = await commitState(buildMoveChatState(state, message.conversationId, message.projectId));
        return { ok: true, state: nextState };
      }
      case 'upsertChatRefs': {
        const nextState = await commitState(buildUpsertChatRefsState(state, message.chats));
        return { ok: true, state: nextState };
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

webext.storage?.onChanged?.addListener((
  changes: Record<string, chrome.storage.StorageChange>,
  area: string
) => {
  if (area === 'local' && changes[STORAGE_KEY]) {
    cachedState = migrateState(changes[STORAGE_KEY].newValue);
  }
});

webext.runtime.onMessage.addListener((
  message: BackgroundRequest,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response: BackgroundResponse) => void
) => {
  handleMessage(message)
    .then((response) => sendResponse(response))
    .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
