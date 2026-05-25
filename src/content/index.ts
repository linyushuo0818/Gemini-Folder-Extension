import { BackgroundRequest, BackgroundResponse, ChatRef, Project, RuntimeState } from '../shared/types';
import { runtimeSendMessage } from '../shared/webext';
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
import { initGeminiResponseFolding } from './gemini/responseFolding';

import { initChatGPT } from './chatgpt';

const DEBUG_LOG = false;
const DEBUG_PROJECT = true;
const BUILD_MARKER = '2026-05-25-new-gemini-ui';
const FORCE_HOVER_CLASS = 'gp-force-hover';

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
let projectsBridgeInitialized = false;
let activeForcedHoverNode: HTMLElement | null = null;

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

function stampBuildMarker(): void {
  document.documentElement.setAttribute('data-gp-build', BUILD_MARKER);
}

function sendMessage(message: BackgroundRequest): Promise<BackgroundResponse> {
  return runtimeSendMessage<BackgroundResponse>(message);
}

function normalizeChatTitleAndPinned(rawTitle: string, row?: Element | null): { title: string; pinnedFromDom: boolean } {
  const source = (rawTitle || '').trim();
  const rowText = ((row as HTMLElement | null)?.textContent || '').trim();
  const combined = `${source} ${rowText}`.toLowerCase();

  const pinnedFromDom = /(?:\bpinned\b|已置顶|置顶)/i.test(combined);
  const cleaned = source
    .replace(/\s*(?:[-–—|·•]?\s*)?(?:pinned)(?:\.{3}|…)?\s*$/i, '')
    .replace(/\s*(?:[-–—|·•]?\s*)?(?:已置顶|置顶)(?:\.{3}|…)?\s*$/i, '')
    .trim();

  return {
    title: cleaned || source,
    pinnedFromDom
  };
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
  stampBuildMarker();

  if (window.location.hostname.includes('chatgpt.com') || window.location.hostname.includes('openai.com')) {
    initChatGPT();
    return;
  }

  try {
    const response = await withTimeout(sendMessage({ type: 'getState' }), 1500);
    if (response?.ok && response.state) {
      state.projects = response.state.projects;
      state.chatIndex = new Map(Object.entries(response.state.chatIndex));
      state.uiPrefs = response.state.uiPrefs || { projectsCollapsed: false };
    }
  } catch (error) {
    // Do not block UI features when background messaging fails temporarily.
    // eslint-disable-next-line no-console
    console.warn('[gemini-projects] getState failed, continue bootstrap with defaults', error);
  }

  runStage('observeSidebar', () => observeSidebar());
  runStage('initProjectsInteractionBridge', () => initProjectsInteractionBridge());
  runStage('attachChatClickTracker', () => attachChatClickTracker());
  runStage('initGeminiResponseFolding', () => initGeminiResponseFolding());
  runStage('prompts.bootstrap', () => prompts.bootstrap());
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: number | null = null;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = window.setTimeout(() => {
      reject(new Error(`timeout(${timeoutMs}ms)`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== null) {
      window.clearTimeout(timer);
    }
  });
}

function runStage(name: string, fn: () => void): void {
  try {
    fn();
  } catch (error) {
    // Stage-level isolation: one feature failure must not block others.
    // eslint-disable-next-line no-console
    console.error(`[gemini-projects] bootstrap stage failed: ${name}`, error);
  }
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

function getProjectsHost(): HTMLElement | null {
  const host = document.getElementById('gemini-projects-host');
  return host instanceof HTMLElement && host.shadowRoot ? host : null;
}

function isInsideProjectsShadow(host: HTMLElement, node: Node | null): boolean {
  return !!(host.shadowRoot && node && host.shadowRoot.contains(node));
}

function getProjectsInteractiveTargetAtPoint(host: HTMLElement, x: number, y: number): HTMLElement | null {
  if (!host.shadowRoot) return null;

  const selectors = [
    '[data-gp-action="project-menu"]',
    '[data-gp-action="chat-menu"]',
    '.gp-chat-link',
    '[data-gp-action="new-project"]',
    '[data-gp-action="toggle-project"]',
    '[data-gp-action="toggle-section"]',
    '.gp-chat-row',
    '.gp-row',
    '.gp-title'
  ];

  const candidates: Array<{ node: HTMLElement; priority: number; area: number }> = [];
  selectors.forEach((selector) => {
    host.shadowRoot!.querySelectorAll<HTMLElement>(selector).forEach((node) => {
      const style = window.getComputedStyle(node);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      const rect = node.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;

      let priority = 9;
      if (node.matches('[data-gp-action="project-menu"], [data-gp-action="chat-menu"]')) priority = 0;
      else if (node.matches('.gp-chat-link')) priority = 1;
      else if (node.matches('[data-gp-action="new-project"], [data-gp-action="toggle-project"], [data-gp-action="toggle-section"]')) priority = 2;
      else if (node.matches('.gp-chat-row, .gp-row, .gp-title')) priority = 3;

      candidates.push({ node, priority, area: rect.width * rect.height });
    });
  });

  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.area - b.area;
  });

  return candidates[0]?.node ?? null;
}

function getProjectsHoverNode(target: HTMLElement | null): HTMLElement | null {
  if (!target) return null;
  return target.closest('.gp-chat-row, .gp-row, .gp-title') as HTMLElement | null;
}

function clearProjectsForcedHover(): void {
  if (activeForcedHoverNode) {
    activeForcedHoverNode.classList.remove(FORCE_HOVER_CLASS);
    activeForcedHoverNode = null;
  }
}

function updateProjectsForcedHover(x: number, y: number): void {
  const host = getProjectsHost();
  if (!host) {
    clearProjectsForcedHover();
    return;
  }

  const topNode = document.elementFromPoint(x, y);
  if (isInsideProjectsShadow(host, topNode)) {
    clearProjectsForcedHover();
    return;
  }

  const target = getProjectsInteractiveTargetAtPoint(host, x, y);
  const hoverNode = getProjectsHoverNode(target);
  if (!hoverNode) {
    clearProjectsForcedHover();
    return;
  }

  if (activeForcedHoverNode === hoverNode) {
    return;
  }

  clearProjectsForcedHover();
  activeForcedHoverNode = hoverNode;
  activeForcedHoverNode.classList.add(FORCE_HOVER_CLASS);
}

function bridgeProjectsClick(event: MouseEvent): void {
  const host = getProjectsHost();
  if (!host) return;

  const topNode = document.elementFromPoint(event.clientX, event.clientY);
  if (isInsideProjectsShadow(host, topNode)) {
    return;
  }

  const target = getProjectsInteractiveTargetAtPoint(host, event.clientX, event.clientY);
  if (!target) return;

  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
  target.click();
}

function initProjectsInteractionBridge(): void {
  if (projectsBridgeInitialized) return;
  projectsBridgeInitialized = true;

  document.addEventListener('pointermove', (event) => {
    updateProjectsForcedHover(event.clientX, event.clientY);
  }, true);

  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('#gp-overlay-layer, #gemini-projects-overlay')) {
      return;
    }
    bridgeProjectsClick(event);
  }, true);

  window.addEventListener('blur', () => clearProjectsForcedHover());
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
  if (!chats) {
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
    const row = link.closest('[role="listitem"], li, div') || link;
    const normalized = normalizeChatTitleAndPinned((link.textContent || '').trim() || existing?.title || '', row);
    const title = normalized.title || existing?.title || '';
    state.chatIndex.set(conversationId, {
      conversationId,
      title,
      isPinned: normalized.pinnedFromDom ? true : (existing?.isPinned ?? false),
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
          isPinned: normalized.pinnedFromDom ? true : (existing?.isPinned ?? false),
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
    const normalized = normalizeChatTitleAndPinned((link.textContent || '').trim(), row);
    const title = normalized.title;
    if (!title) return;
    updates.push({
      conversationId,
      title,
      isPinned: normalized.pinnedFromDom ? true : (state.chatIndex.get(conversationId)?.isPinned ?? false),
      updatedAt: Date.now(),
      projectId: state.chatIndex.get(conversationId)?.projectId ?? null,
      lastUrl: link.href
    });
  });

  if (updates.length) {
    updates.forEach((chat) => {
      const existing = state.chatIndex.get(chat.conversationId);
      state.chatIndex.set(chat.conversationId, {
        ...chat,
        projectId: existing?.projectId ?? chat.projectId,
        isPinned: typeof chat.isPinned === 'boolean' ? chat.isPinned : (existing?.isPinned ?? false)
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

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('[gemini-projects] bootstrap failed', error);
  log('bootstrap failed', error);
});

