import { BackgroundRequest, BackgroundResponse, ChatRef, Project, RuntimeState } from '../shared/types';
import { runtimeSendMessage } from '../shared/webext';
import {
  findChatRowElement,
  findChatsListContainer,
  findChatsSection,
  findGemsSection,
  findSidebarRoot,
  getConversationId,
  getConversationIdFromChatRow,
  injectProjectsSection
} from './dom/anchors';
import { attachChatMenuEnhancer } from './dom/menus';
import { initGeminiResponseFolding } from './gemini/responseFolding';
import * as prompts from './prompts';
import { installSidebarInspector } from './sidebarInspector';
import { createProjectsPanel } from './ui/projectsPanel';
import { initChatGPT } from './chatgpt';

const BUILD_MARKER = '2026-06-14-minimal-rewrite-v067';
const HIDDEN_ATTR = 'data-gp-native-hidden';
const RESCAN_DELAY_MS = 350;
const MIN_EXPANDED_SIDEBAR_WIDTH = 180;

const state: RuntimeState = {
  projects: [],
  chatIndex: new Map(),
  expandedProjectIds: new Set(),
  nativeConversationIds: new Set(),
  nativeChatsReady: false,
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
let rootObserver: MutationObserver | null = null;
let sidebarObserver: MutationObserver | null = null;
let chatsObserver: MutationObserver | null = null;
let rescanTimer: number | null = null;
let lastRenderKey = '';
let chatMenuAttached = false;

function sendMessage(message: BackgroundRequest): Promise<BackgroundResponse> {
  return runtimeSendMessage<BackgroundResponse>(message);
}

async function bootstrap() {
  document.documentElement.setAttribute('data-gp-build', BUILD_MARKER);

  if (window.location.hostname.includes('chatgpt.com') || window.location.hostname.includes('openai.com')) {
    initChatGPT();
    return;
  }

  installSidebarInspector();
  installNativeHideStyle();
  await loadInitialState();
  observeDocumentForSidebar();
  runStage('responseFolding', () => initGeminiResponseFolding());
  runStage('prompts', () => prompts.bootstrap());
}

async function loadInitialState() {
  try {
    const response = await withTimeout(sendMessage({ type: 'getState' }), 1800);
    if (!response.ok || !response.state) return;
    state.projects = response.state.projects;
    state.chatIndex = new Map(Object.entries(response.state.chatIndex));
    state.uiPrefs = response.state.uiPrefs || { projectsCollapsed: false };
  } catch (error) {
    console.warn('[gemini-projects] getState failed; starting with local empty state', error);
  }
}

function observeDocumentForSidebar() {
  rootObserver?.disconnect();
  rootObserver = new MutationObserver(() => scheduleRescan());
  rootObserver.observe(document.body, { childList: true });
  scheduleRescan(0);
}

function scheduleRescan(delay = RESCAN_DELAY_MS) {
  if (rescanTimer !== null) window.clearTimeout(rescanTimer);
  rescanTimer = window.setTimeout(() => {
    rescanTimer = null;
    runStage('rescanSidebar', rescanSidebar);
  }, delay);
}

function rescanSidebar() {
  const nextSidebar = findSidebarRoot();
  if (!nextSidebar) return;

  if (!isExpandedSidebar(nextSidebar)) {
    state.nativeConversationIds = new Set();
    state.nativeChatsReady = false;
    cleanupInjectedProjects();
    return;
  }

  if (sidebarRoot !== nextSidebar) {
    sidebarRoot = nextSidebar;
    sidebarObserver?.disconnect();
    sidebarObserver = new MutationObserver(() => scheduleRescan());
    sidebarObserver.observe(sidebarRoot, { childList: true, subtree: true });
    panel = null;
    chatsList = null;
  }

  if (!ensurePanel()) return;
  ensureChatsList();
  syncNativeChatsFromDom();
  applyNativeChatVisibility();
  renderPanelIfChanged();
}

function ensurePanel() {
  if (!sidebarRoot) return false;
  if (!isExpandedSidebar(sidebarRoot)) return false;
  const chats = findChatsSection(sidebarRoot);
  if (!chats) {
    cleanupInjectedProjects();
    return false;
  }
  const nativeChatsList = findChatsListContainer(chats);
  if (!nativeChatsList) {
    cleanupInjectedProjects();
    return false;
  }
  const gems = findGemsSection(sidebarRoot);
  const { shadow, overlayShadow } = injectProjectsSection(sidebarRoot, gems, chats);

  if (!panel) {
    panel = createProjectsPanel({
      shadow,
      overlayShadow,
      onSaveProject: handleSaveProject,
      onToggleProjectExpand: handleToggleProjectExpand,
      onDeleteProject: handleDeleteProject,
      onToggleCollapse: handleToggleCollapse,
      onRemoveChatFromProject: (conversationId) => handleMoveChat(conversationId, null),
      onMoveChatToProject: (conversationId, projectId) => handleMoveChat(conversationId, projectId)
    });
  }

  if (!chatMenuAttached) {
    attachChatMenuEnhancer({
      overlayShadow,
      getProjects: () => state.projects,
      getChatProjectId: (conversationId) => state.chatIndex.get(conversationId)?.projectId ?? null,
      onMoveChat: (conversationId, projectId) => {
        handleMoveChat(conversationId, projectId).catch((error) =>
          console.warn('[gemini-projects] move from menu failed', error)
        );
      },
      onCreateProject: () => panel?.openCreateModal()
    });
    chatMenuAttached = true;
  }
  return true;
}

function ensureChatsList() {
  if (!sidebarRoot) return;
  const header = findChatsSection(sidebarRoot);
  if (!header) return;
  chatsHeader = header;

  const list = findChatsListContainer(header);
  if (!list || list === chatsList) return;

  chatsList = list;
  chatsObserver?.disconnect();
  chatsObserver = new MutationObserver((mutations) => {
    if (mutations.some((mutation) => isRelevantChatsMutation(mutation))) {
      scheduleRescan();
    }
  });
  chatsObserver.observe(chatsList, { childList: true, subtree: true });
}

function syncNativeChatsFromDom() {
  if (!chatsList) {
    state.nativeConversationIds = new Set();
    state.nativeChatsReady = false;
    return;
  }

  const updates: ChatRef[] = [];
  const nativeConversationIds = new Set<string>();
  for (const link of collectNativeChatLinks(chatsList)) {
    const row = findChatRowElement(link, chatsList) || link;
    const conversationId = getConversationId(link.href) || getConversationIdFromChatRow(row);
    if (!conversationId) continue;
    nativeConversationIds.add(conversationId);

    const existing = state.chatIndex.get(conversationId);
    const title = normalizeTitle(link.textContent || row.textContent || existing?.title || '');
    const lastUrl = link.href || existing?.lastUrl || `/app/${conversationId}`;
    if (!title && existing?.title) continue;

    updates.push({
      conversationId,
      title: title || existing?.title || 'Untitled chat',
      isPinned: existing?.isPinned ?? false,
      projectId: existing?.projectId ?? null,
      updatedAt: existing?.updatedAt ?? Date.now(),
      lastUrl
    });
  }
  state.nativeConversationIds = nativeConversationIds;
  state.nativeChatsReady = nativeConversationIds.size > 0;

  if (!updates.length) return;

  let changed = false;
  for (const chat of updates) {
    const existing = state.chatIndex.get(chat.conversationId);
    if (
      existing?.title !== chat.title ||
      existing?.lastUrl !== chat.lastUrl ||
      existing?.projectId !== chat.projectId
    ) {
      changed = true;
    }
    state.chatIndex.set(chat.conversationId, {
      ...chat,
      projectId: existing?.projectId ?? chat.projectId,
      updatedAt: existing?.updatedAt ?? Date.now()
    });
  }

  if (changed) {
    sendMessage({ type: 'upsertChatRefs', chats: updates }).catch(() => undefined);
  }
}

function applyNativeChatVisibility() {
  if (!chatsList) return;

  const touchedRows = new Set<HTMLElement>();
  for (const link of collectNativeChatLinks(chatsList)) {
    const row = findChatRowElement(link, chatsList);
    const conversationId = getConversationId(link.href) || getConversationIdFromChatRow(row);
    const target = getNativeChatVisibilityTarget(row, link, chatsList);
    if (!conversationId || !target) continue;

    touchedRows.add(target);
    if (state.chatIndex.get(conversationId)?.projectId) {
      target.setAttribute(HIDDEN_ATTR, 'true');
    } else {
      target.removeAttribute(HIDDEN_ATTR);
    }
  }

  chatsList.querySelectorAll<HTMLElement>(`[${HIDDEN_ATTR}]`).forEach((node) => {
    if (!touchedRows.has(node)) node.removeAttribute(HIDDEN_ATTR);
  });
}

function getNativeChatVisibilityTarget(
  row: HTMLElement | null,
  link: HTMLAnchorElement,
  listRoot: HTMLElement
): HTMLElement | null {
  if (row) {
    const safeRow = getSafeNativeChatRow(row, link, listRoot);
    if (safeRow) return safeRow;
  }
  return listRoot.contains(link) ? link : null;
}

function collectNativeChatLinks(root: ParentNode): HTMLAnchorElement[] {
  return Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]')).filter((link) => {
    if (!getConversationId(link.href)) return false;
    if (link.closest('#gemini-projects-host')) return false;
    return true;
  });
}

function getSafeNativeChatRow(
  row: HTMLElement,
  link: HTMLAnchorElement,
  listRoot: HTMLElement
): HTMLElement | null {
  if (!listRoot.contains(row)) return null;
  if (row === listRoot || row === sidebarRoot || row === document.body || row === document.documentElement) return null;
  if (!row.contains(link)) return null;
  if (row.contains(document.getElementById('gemini-projects-host'))) return null;
  if (row.querySelectorAll<HTMLAnchorElement>('a[href*="/app/"]').length !== 1) return null;

  const rect = row.getBoundingClientRect();
  const listRect = listRoot.getBoundingClientRect();
  if (rect.height <= 0 || rect.height > 96) return null;
  if (rect.width <= 0 || rect.width > listRect.width + 16) return null;

  const tag = row.tagName.toLowerCase();
  const role = row.getAttribute('role') || '';
  if (tag === 'li' || role === 'listitem') return row;

  const parentConversationCount = row.parentElement
    ? collectNativeChatLinks(row.parentElement).length
    : Number.POSITIVE_INFINITY;
  return parentConversationCount > 1 ? row : null;
}

async function handleSaveProject(project: Project) {
  const response = await sendMessage({ type: 'upsertProject', project });
  if (!response.ok || !response.state) return;
  state.projects = response.state.projects;
  renderPanelIfChanged(true);
}

function handleToggleProjectExpand(projectId: string) {
  if (state.expandedProjectIds.has(projectId)) {
    state.expandedProjectIds.delete(projectId);
  } else {
    state.expandedProjectIds.add(projectId);
  }
  renderPanelIfChanged(true);
}

function handleToggleCollapse(collapsed: boolean) {
  state.uiPrefs.projectsCollapsed = collapsed;
  sendMessage({ type: 'updateUiPrefs', prefs: { projectsCollapsed: collapsed } }).catch(() => undefined);
  renderPanelIfChanged(true);
}

async function handleDeleteProject(projectId: string) {
  const response = await sendMessage({ type: 'deleteProject', projectId });
  if (!response.ok || !response.state) return;
  state.projects = response.state.projects;
  state.chatIndex = new Map(Object.entries(response.state.chatIndex));
  state.expandedProjectIds.delete(projectId);
  applyNativeChatVisibility();
  renderPanelIfChanged(true);
}

async function handleMoveChat(conversationId: string, projectId: string | null) {
  await ensureChatKnown(conversationId);
  const response = await sendMessage({ type: 'moveChat', conversationId, projectId });
  if (!response.ok || !response.state) return;
  state.projects = response.state.projects ?? state.projects;
  state.chatIndex = new Map(Object.entries(response.state.chatIndex));
  applyNativeChatVisibility();
  renderPanelIfChanged(true);
}

async function ensureChatKnown(conversationId: string) {
  const existing = state.chatIndex.get(conversationId);
  if (existing?.title && existing.lastUrl) return;

  const link = findNativeLinkByConversationId(conversationId);
  if (!link) return;

  const row = chatsList ? findChatRowElement(link, chatsList) : link;
  const chat: ChatRef = {
    conversationId,
    title: normalizeTitle(link.textContent || row?.textContent || existing?.title || '') || 'Untitled chat',
    isPinned: existing?.isPinned ?? false,
    projectId: existing?.projectId ?? null,
    updatedAt: Date.now(),
    lastUrl: link.href
  };
  state.chatIndex.set(conversationId, chat);
  await sendMessage({ type: 'upsertChatRefs', chats: [chat] }).catch(() => undefined);
}

function findNativeLinkByConversationId(conversationId: string): HTMLAnchorElement | null {
  const roots: ParentNode[] = [chatsList, sidebarRoot, document].filter(Boolean) as ParentNode[];
  for (const root of roots) {
    const link = collectNativeChatLinks(root).find((candidate) => getConversationId(candidate.href) === conversationId);
    if (link) return link;
  }
  return null;
}

function normalizeTitle(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\s*(?:Pinned|已置顶|置顶)\s*$/i, '')
    .trim();
}

function installNativeHideStyle() {
  if (document.getElementById('gp-native-hide-style')) return;
  const style = document.createElement('style');
  style.id = 'gp-native-hide-style';
  style.textContent = `[${HIDDEN_ATTR}="true"] { display: none !important; }`;
  document.documentElement.appendChild(style);
}

function isExpandedSidebar(sidebar: HTMLElement): boolean {
  const rect = sidebar.getBoundingClientRect();
  const style = window.getComputedStyle(sidebar);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  if (rect.width < MIN_EXPANDED_SIDEBAR_WIDTH || rect.height <= 0) return false;
  if (rect.right <= 0 || rect.left >= window.innerWidth) return false;
  return Boolean(findChatsSection(sidebar) || findChatsListContainer(findChatsSection(sidebar)));
}

function cleanupInjectedProjects() {
  panel = null;
  chatsList = null;
  state.nativeConversationIds = new Set();
  state.nativeChatsReady = false;
  lastRenderKey = '';
  document.getElementById('gemini-projects-host')?.remove();
  document.getElementById('gemini-projects-overlay')?.remove();
  document.querySelectorAll<HTMLElement>(`[${HIDDEN_ATTR}]`).forEach((node) => node.removeAttribute(HIDDEN_ATTR));
}

function isRelevantChatsMutation(mutation: MutationRecord): boolean {
  if (mutation.target instanceof HTMLElement && mutation.target.closest('#gemini-projects-host')) {
    return false;
  }
  return Array.from(mutation.addedNodes).some(nodeHasConversationLink) ||
    Array.from(mutation.removedNodes).some(nodeHasConversationLink);
}

function nodeHasConversationLink(node: Node): boolean {
  if (!(node instanceof Element)) return false;
  if (node.closest('#gemini-projects-host')) return false;
  if (node instanceof HTMLAnchorElement && getConversationId(node.href)) return true;
  return Boolean(Array.from(node.querySelectorAll<HTMLAnchorElement>('a[href]')).find((link) => getConversationId(link.href)));
}

function renderPanelIfChanged(force = false) {
  if (!panel) return;
  const key = getRenderKey();
  if (!force && key === lastRenderKey) return;
  lastRenderKey = key;
  panel.render(state);
}

function getRenderKey(): string {
  const projects = state.projects
    .map((project) => `${project.id}:${project.name}:${project.icon}:${project.color || ''}:${project.sortIndex}`)
    .join('|');
  const chats = Array.from(state.chatIndex.values())
    .filter((chat) => chat.projectId)
    .map((chat) => {
      const missing = state.nativeChatsReady && !state.nativeConversationIds.has(chat.conversationId);
      return `${chat.conversationId}:${chat.title}:${chat.projectId}:${chat.lastUrl || ''}:${chat.updatedAt}:${missing}`;
    })
    .sort()
    .join('|');
  return `${state.uiPrefs.projectsCollapsed}|${Array.from(state.expandedProjectIds).sort().join(',')}|${projects}|${chats}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: number | null = null;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(`timeout(${timeoutMs}ms)`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer !== null) window.clearTimeout(timer);
  });
}

function runStage(name: string, fn: () => void) {
  try {
    fn();
  } catch (error) {
    console.error(`[gemini-projects] stage failed: ${name}`, error);
  }
}

bootstrap().catch((error) => {
  console.error('[gemini-projects] bootstrap failed', error);
});
