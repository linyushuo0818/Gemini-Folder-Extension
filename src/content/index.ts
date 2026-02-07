import { BackgroundRequest, BackgroundResponse, ChatRef, Project, RuntimeState } from '../shared/types';
import {
  findSidebarRoot,
  findGemsSection,
  findChatsSection,
  findChatsListContainer,
  injectProjectsSection,
  getConversationId,
  getConversationIdFromChatRow
} from './dom/anchors';
import { attachChatMenuEnhancer } from './dom/menus';
import { createProjectsPanel } from './ui/projectsPanel';
import * as prompts from './prompts';

const DEBUG_LOG = false;
const DEBUG_PROJECT = true;

const state: RuntimeState = {
  projects: [],
  chatIndex: new Map(),
  expandedProjectIds: new Set(),
  ui: {
    createModalOpen: false,
    contextMenuOpen: false,
    pendingMoveConversationId: null
  },
  uiPrefs: { projectsCollapsed: false }
};

let panel: ReturnType<typeof createProjectsPanel> | null = null;
let sidebarRoot: HTMLElement | null = null;
let chatsHeader: HTMLElement | null = null;
let chatsList: HTMLElement | null = null;
let chatsObserver: MutationObserver | null = null;
let menuEnhancerCleanup: (() => void) | null = null;

function log(...args: unknown[]) {
  if (DEBUG_LOG) {
    // eslint-disable-next-line no-console
    console.log('[gemini-projects]', ...args);
  }
}

function logProject(...args: unknown[]) {
  if (DEBUG_PROJECT) {
    // eslint-disable-next-line no-console
    console.log('[gp-project]', ...args);
  }
}
function sendMessage(message: BackgroundRequest): Promise<BackgroundResponse> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => resolve(response as BackgroundResponse));
  });
}

export function getChatProjectId(conversationId: string): string | null {
  return state.chatIndex.get(conversationId)?.projectId ?? null;
}

export function renderProjectsSection(
  projects: Project[],
  chatIndex: Map<string, ChatRef>,
  expandedProjectIds: Set<string>
) {
  state.projects = projects;
  state.chatIndex = chatIndex;
  state.expandedProjectIds = expandedProjectIds;
  panel?.render(state);
}

export function renderUnassignedChatsSection(chatIndex: Map<string, ChatRef>) {
  if (!chatsList) return;
  const chatLinks = Array.from(chatsList.querySelectorAll<HTMLAnchorElement>('a[href]'));
  chatLinks.forEach((link) => {
    const row = link.closest('[role="listitem"], li, div') || link;
    const conversationId = getConversationIdFromChatRow(row) || getConversationId(link.href);
    if (!conversationId) {
      (row as HTMLElement).style.display = '';
      return;
    }
    const chat = chatIndex.get(conversationId);
    const shouldHide = !!chat?.projectId;
    (row as HTMLElement).style.display = shouldHide ? 'none' : '';
  });
}

async function bootstrap() {
  const response = await sendMessage({ type: 'getState' });
  if (response.ok && response.state) {
    state.projects = response.state.projects;
    state.chatIndex = new Map(Object.entries(response.state.chatIndex));
    state.uiPrefs = response.state.uiPrefs || { projectsCollapsed: false };
  }

  observeSidebar();
  attachChatClickTracker();

  // Initialize Prompts Feature
  prompts.bootstrap();
}

function observeSidebar() {
  const tryInject = () => {
    if (sidebarRoot && document.contains(sidebarRoot)) {
      ensurePanel();
      return;
    }

    sidebarRoot = findSidebarRoot();
    if (!sidebarRoot) {
      return;
    }

    ensurePanel();
    attachSidebarObserver();
  };

  const rootObserver = new MutationObserver(() => tryInject());
  rootObserver.observe(document.body, { childList: true, subtree: true });
  tryInject();
}

function attachSidebarObserver() {
  if (!sidebarRoot) return;

  const observer = new MutationObserver(() => {
    ensurePanel();
    ensureChatsObserver();
  });

  observer.observe(sidebarRoot, { childList: true, subtree: true });
}

function ensurePanel() {
  if (!sidebarRoot) return;
  const gems = findGemsSection(sidebarRoot);
  const chats = findChatsSection(sidebarRoot);
  if (!gems || !chats) {
    return;
  }

  const { shadow, overlayShadow } = injectProjectsSection(sidebarRoot, gems, chats);

  if (!panel) {
    panel = createProjectsPanel({
      shadow,
      overlayShadow,
      onSaveProject: handleCreateProject,
      onToggleProjectExpand: handleToggleProjectExpand,
      onDeleteProject: handleDeleteProject,
      onToggleCollapse: handleToggleCollapse,
      // 聊天菜单回调 (Chat menu callbacks)
      onRemoveChatFromProject: handleRemoveChatFromProject,
      onMoveChatToProject: handleMoveChatToProject
    });
  }

  renderProjectsSection(state.projects, state.chatIndex, state.expandedProjectIds);

  if (!menuEnhancerCleanup) {
    menuEnhancerCleanup = attachChatMenuEnhancer({
      overlayShadow,
      getProjects: () => state.projects,
      getChatProjectId,
      onMoveChat: handleMoveChat,
      onCreateProject: () => panel?.openCreateModal()
    });
  }

  ensureChatsObserver();
}

function ensureChatsObserver() {
  if (!sidebarRoot) return;
  const header = findChatsSection(sidebarRoot);
  if (!header) return;
  chatsHeader = header;

  const list = findChatsListContainer(chatsHeader);
  if (!list) return;

  if (chatsList !== list) {
    chatsList = list;
    if (chatsObserver) {
      chatsObserver.disconnect();
    }
    chatsObserver = new MutationObserver(() => {
      syncChatsFromDom();
      renderUnassignedChatsSection(state.chatIndex);
      renderProjectsSection(state.projects, state.chatIndex, state.expandedProjectIds);
    });
    chatsObserver.observe(chatsList, { childList: true, subtree: true });
  }

  syncChatsFromDom();
  renderUnassignedChatsSection(state.chatIndex);
}

function attachChatClickTracker() {
  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const link = target.closest('a[href]') as HTMLAnchorElement | null;
    if (!link) return;
    const conversationId = getConversationId(link.href);
    if (!conversationId) return;
    const existing = state.chatIndex.get(conversationId);
    const title = (link.textContent || '').trim() || existing?.title || '';
    state.chatIndex.set(conversationId, {
      conversationId,
      title,
      projectId: existing?.projectId ?? null,
      updatedAt: Date.now(),
      lastUrl: link.href
    });
    sendMessage({
      type: 'upsertChatRefs',
      chats: [
        {
          conversationId,
          title,
          projectId: existing?.projectId ?? null,
          updatedAt: Date.now(),
          lastUrl: link.href
        }
      ]
    }).catch(() => undefined);
  });
}

function syncChatsFromDom() {
  if (!chatsList) return;
  const chatLinks = Array.from(chatsList.querySelectorAll<HTMLAnchorElement>('a[href]'));
  const updates: ChatRef[] = [];

  chatLinks.forEach((link) => {
    const row = link.closest('[role="listitem"], li, div') || link;
    const conversationId = getConversationIdFromChatRow(row) || getConversationId(link.href);
    if (!conversationId) return;
    const title = (link.textContent || '').trim();
    if (!title) return;
    updates.push({
      conversationId,
      title,
      updatedAt: Date.now(),
      projectId: state.chatIndex.get(conversationId)?.projectId ?? null,
      lastUrl: link.href
    });
  });

  if (updates.length) {
    updates.forEach((chat) => {
      state.chatIndex.set(chat.conversationId, {
        ...chat,
        projectId: state.chatIndex.get(chat.conversationId)?.projectId ?? chat.projectId
      });
    });
    sendMessage({ type: 'upsertChatRefs', chats: updates }).catch(() => undefined);
  }
}

async function handleCreateProject(project: Project) {
  const response = await sendMessage({ type: 'upsertProject', project });
  if (response.ok && response.state) {
    state.projects = response.state.projects;
    renderProjectsSection(state.projects, state.chatIndex, state.expandedProjectIds);
  }
}

function handleToggleProjectExpand(projectId: string) {
  if (state.expandedProjectIds.has(projectId)) {
    state.expandedProjectIds.delete(projectId);
  } else {
    state.expandedProjectIds.add(projectId);
    const count = Array.from(state.chatIndex.values()).filter((chat) => chat.projectId === projectId).length;
    logProject('expand projectId=', projectId, 'items=', count);
  }
  renderProjectsSection(state.projects, state.chatIndex, state.expandedProjectIds);
}

function handleToggleCollapse(collapsed: boolean) {
  state.uiPrefs.projectsCollapsed = collapsed;
  sendMessage({ type: 'updateUiPrefs', prefs: { projectsCollapsed: collapsed } });
  renderProjectsSection(state.projects, state.chatIndex, state.expandedProjectIds);
}

async function handleRenameProject(projectId: string, name: string) {
  const response = await sendMessage({ type: 'renameProject', projectId, name });
  if (response.ok && response.state) {
    state.projects = response.state.projects;
    renderProjectsSection(state.projects, state.chatIndex, state.expandedProjectIds);
  }
}

async function handleDeleteProject(projectId: string) {
  const response = await sendMessage({ type: 'deleteProject', projectId });
  if (response.ok && response.state) {
    state.projects = response.state.projects;
    state.chatIndex = new Map(Object.entries(response.state.chatIndex));
    state.expandedProjectIds.delete(projectId);
    renderProjectsSection(state.projects, state.chatIndex, state.expandedProjectIds);
    renderUnassignedChatsSection(state.chatIndex);
  }
}

async function handleMoveChat(conversationId: string, projectId: string | null) {
  logProject('moveChat conversationId=', conversationId, 'to projectId=', projectId);
  const response = await sendMessage({ type: 'moveChat', conversationId, projectId });
  if (response.ok && response.state) {
    state.chatIndex = new Map(Object.entries(response.state.chatIndex));
    renderProjectsSection(state.projects, state.chatIndex, state.expandedProjectIds);
    renderUnassignedChatsSection(state.chatIndex);
  }
}

// 从项目中移除聊天（移动到未分类）
async function handleRemoveChatFromProject(conversationId: string) {
  logProject('removeChatFromProject conversationId=', conversationId);
  await handleMoveChat(conversationId, null);
}

// 将聊天移动到另一个项目
async function handleMoveChatToProject(conversationId: string, projectId: string) {
  logProject('moveChatToProject conversationId=', conversationId, 'to projectId=', projectId);
  await handleMoveChat(conversationId, projectId);
}

bootstrap().catch((error) => log('bootstrap failed', error));
