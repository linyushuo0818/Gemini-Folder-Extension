import { BackgroundRequest, BackgroundResponse, ChatRef, Project, StoredState } from './shared/types';
import { createEmptyState, loadState, saveState } from './shared/storage';

let cachedState: StoredState | null = null;
let loadPromise: Promise<StoredState> | null = null;

async function getState(): Promise<StoredState> {
  if (cachedState) {
    return cachedState;
  }
  if (!loadPromise) {
    loadPromise = loadState().catch(() => createEmptyState());
  }
  cachedState = await loadPromise;
  return cachedState;
}

async function persist(state: StoredState): Promise<void> {
  cachedState = state;
  await saveState(state);
}

function upsertProject(state: StoredState, project: Project): StoredState {
  const idx = state.projects.findIndex((item) => item.id === project.id);
  if (idx >= 0) {
    state.projects[idx] = {
      ...state.projects[idx],
      ...project,
      updatedAt: project.updatedAt ?? Date.now()
    };
  } else {
    state.projects.push(project);
  }
  return state;
}

function renameProject(state: StoredState, projectId: string, name: string): StoredState {
  const project = state.projects.find((item) => item.id === projectId);
  if (project) {
    project.name = name;
    project.updatedAt = Date.now();
  }
  return state;
}

function deleteProject(state: StoredState, projectId: string): StoredState {
  state.projects = state.projects.filter((item) => item.id !== projectId);
  Object.values(state.chatIndex).forEach((chat) => {
    if (chat.projectId === projectId) {
      chat.projectId = null;
    }
  });
  return state;
}

function moveChat(state: StoredState, conversationId: string, projectId: string | null): StoredState {
  const existing = state.chatIndex[conversationId];
  state.chatIndex[conversationId] = {
    conversationId,
    title: existing?.title ?? '',
    isPinned: existing?.isPinned ?? false,
    projectId,
    updatedAt: Date.now(),
    lastUrl: existing?.lastUrl
  };
  return state;
}

function upsertChatRefs(state: StoredState, chats: ChatRef[]): StoredState {
  chats.forEach((chat) => {
    const existing = state.chatIndex[chat.conversationId];
    state.chatIndex[chat.conversationId] = {
      conversationId: chat.conversationId,
      title: chat.title || existing?.title || '',
      isPinned: typeof chat.isPinned === 'boolean' ? chat.isPinned : (existing?.isPinned ?? false),
      projectId: chat.projectId ?? existing?.projectId ?? null,
      updatedAt: chat.updatedAt ?? existing?.updatedAt ?? Date.now(),
      lastUrl: chat.lastUrl ?? existing?.lastUrl
    };
  });
  return state;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9-_]+/g, '_').replace(/^_+|_+$/g, '') || 'project';
}

function exportProjectJson(state: StoredState, projectId: string): BackgroundResponse {
  const project = state.projects.find((item) => item.id === projectId);
  if (!project) {
    return { ok: false, error: 'Project not found' };
  }
  const chats = Object.values(state.chatIndex)
    .filter((chat) => chat.projectId === project.id)
    .map((chat) => ({ conversationId: chat.conversationId, title: chat.title }));
  const payload = {
    project: {
      id: project.id,
      name: project.name,
      icon: project.icon,
      color: project.color ?? null,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      sortIndex: project.sortIndex
    },
    chats
  };
  const json = JSON.stringify(payload, null, 2);
  const filename = `${sanitizeFilename(project.name)}.json`;
  return { ok: true, json, filename };
}

function updateUiPrefs(state: StoredState, prefs: Partial<StoredState['uiPrefs']>): StoredState {
  state.uiPrefs = { ...state.uiPrefs, ...prefs };
  return state;
}

async function handleMessage(message: BackgroundRequest): Promise<BackgroundResponse> {
  switch (message.type) {
    case 'refreshStateCache': {
      cachedState = await loadState().catch(() => createEmptyState());
      return { ok: true, state: cachedState };
    }
  }

  const state = await getState();

  switch (message.type) {
    case 'getState':
      return { ok: true, state };
    case 'upsertProject':
      await persist(upsertProject(state, message.project));
      return { ok: true, state };
    case 'renameProject':
      await persist(renameProject(state, message.projectId, message.name));
      return { ok: true, state };
    case 'deleteProject':
      await persist(deleteProject(state, message.projectId));
      return { ok: true, state };
    case 'moveChat':
      await persist(moveChat(state, message.conversationId, message.projectId));
      return { ok: true, state };
    case 'upsertChatRefs':
      await persist(upsertChatRefs(state, message.chats));
      return { ok: true, state };
    case 'exportProject': {
      return exportProjectJson(state, message.projectId);
    }
    case 'updateUiPrefs':
      await persist(updateUiPrefs(state, message.prefs));
      return { ok: true, state };
    default:
      return { ok: false, error: 'Unknown message type' };
  }
}

chrome.runtime.onMessage.addListener((message: BackgroundRequest, _sender, sendResponse) => {
  handleMessage(message)
    .then((response) => sendResponse(response))
    .catch((error: Error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
