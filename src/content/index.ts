import { BackgroundRequest, BackgroundResponse, NativeChatMetadata, Project, RuntimeState, StoredState } from '../shared/types';
import { isSafeId, normalizeChatUrl, STORAGE_KEY } from '../shared/storage';
import { runtimeSendMessage, webext } from '../shared/webext';
import {
  findChatRowElement,
  findChatsListContainer,
  findChatsSection,
  findSidebarRoot,
  getConversationId,
  getConversationIdFromChatRow,
  injectProjectsSection
} from './dom/anchors';
import { attachChatMenuEnhancer } from './dom/menus';
import { clearActiveDraggedChat, getActiveDraggedChat, setActiveDraggedChat } from './dom/dragState';
import { initGeminiResponseFolding } from './gemini/responseFolding';
import * as prompts from './prompts';
import { createProjectsPanel } from './ui/projectsPanel';

const BUILD_MARKER = webext.runtime?.getManifest?.()?.version || '2.0.7';
const HIDDEN_ATTR = 'data-gp-native-hidden';
const DRAG_SOURCE_ATTR = 'data-gp-drag-source';
const DROP_UNASSIGN_ATTR = 'data-gp-drop-unassign';
const RESCAN_DELAY_MS = 350;
const PANEL_READY_RETRY_MS = 120;
const PANEL_READY_RETRY_LIMIT = 40;
const MIN_EXPANDED_SIDEBAR_WIDTH = 180;

const state: RuntimeState = {
  projects: [],
  chatIndex: new Map(),
  expandedProjectIds: new Set(),
  nativeConversationIds: new Set(),
  nativeChatsReady: false,
  activeConversationId: getConversationId(window.location.href),
  ui: {
    createModalOpen: false,
    contextMenuOpen: false,
    pendingMoveConversationId: null
  },
  uiPrefs: { projectsCollapsed: false }
};

let panel: ReturnType<typeof createProjectsPanel> | null = null;
let panelHost: HTMLElement | null = null;
let sidebarRoot: HTMLElement | null = null;
let chatsList: HTMLElement | null = null;
let rootObserver: MutationObserver | null = null;
let sidebarObserver: MutationObserver | null = null;
let chatsObserver: MutationObserver | null = null;
let rescanTimer: number | null = null;
let pendingPanelRetryCount = 0;
let lastRenderKey = '';
let chatMenuOverlayShadow: ShadowRoot | null = null;
let detachChatMenu: (() => void) | null = null;
let stateReady = false;
let stateLoading = false;
let scanPending = false;
let unassignZone: HTMLElement | null = null;
let nativeDragSource: HTMLElement | null = null;

function sendMessage(message: BackgroundRequest): Promise<BackgroundResponse> {
  return runtimeSendMessage<BackgroundResponse>(message);
}

async function bootstrap() {
  document.documentElement.setAttribute('data-gp-build', BUILD_MARKER);

  installNativeHideStyle();
  installStorageSync();
  await loadInitialState();
  installNativeDragHandlers();
  observeDocumentForSidebar();
  installLifecycleRescans();
  runStage('responseFolding', () => initGeminiResponseFolding());
  runStage('prompts', () => prompts.bootstrap());
}

async function loadInitialState() {
  if (stateReady || stateLoading) return;
  stateLoading = true;
  try {
    const response = await withTimeout(sendMessage({ type: 'getState' }), 1800);
    if (!response.ok) throw new Error(response.error);
    if (stateReady || !response.state) return;
    stateReady = true;
    state.projects = response.state.projects;
    state.chatIndex = new Map(Object.entries(response.state.chatIndex));
    state.uiPrefs = response.state.uiPrefs || { projectsCollapsed: false };
  } catch (error) {
    console.warn('[gemini-projects] getState failed', error);
  } finally {
    stateLoading = false;
  }
}

// 监听 storage 变更，保证多标签页和备份恢复后状态实时同步。
function installStorageSync() {
  webext.storage?.onChanged?.addListener((
    changes: Record<string, chrome.storage.StorageChange>,
    area: string
  ) => {
    if (area !== 'local' || !changes[STORAGE_KEY]) return;
    const next = changes[STORAGE_KEY].newValue as StoredState | undefined;
    if (!next) return;
    stateReady = true;
    state.projects = next.projects;
    state.chatIndex = new Map(Object.entries(next.chatIndex));
    state.uiPrefs = next.uiPrefs || { projectsCollapsed: false };
    applyNativeChatVisibility();
    renderPanelIfChanged();
  });
}

function observeDocumentForSidebar() {
  rootObserver?.disconnect();
  rootObserver = new MutationObserver((mutations) => {
    const hasRelevantChange = mutations.some((mutation) => {
      if (mutation.target instanceof HTMLElement) {
        if (mutation.target.closest('#gemini-projects-host, #gemini-projects-overlay, #gp-prompt-picker-root')) {
          return false;
        }
        // 流式输出在 main 区域频繁增删子节点，不影响侧栏结构时跳过。
        if (sidebarRoot && sidebarRoot.isConnected && mutation.target.closest('main, [role="main"]')) {
          return false;
        }
      }
      return mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0;
    });
    if (hasRelevantChange) {
      scheduleRescan();
    }
  });
  rootObserver.observe(document.body, { childList: true, subtree: true });
  scheduleRescan(0);
}

function scheduleRescan(delay = RESCAN_DELAY_MS) {
  // 保留已调度的首次扫描，避免高频 DOM 变更导致扫描被无限推迟；仅立即扫描允许抢占。
  if (rescanTimer !== null) {
    if (delay > 0) return;
    window.clearTimeout(rescanTimer);
  }
  rescanTimer = window.setTimeout(() => {
    rescanTimer = null;
    runStage('rescanSidebar', rescanSidebar);
  }, delay);
}

function rescanSidebar() {
  if (!stateReady) void loadInitialState().then(() => { if (stateReady) scheduleRescan(0); });
  state.activeConversationId = getConversationId(window.location.href);

  if (isSparkSurface()) {
    cleanupInjectedProjects();
    return;
  }

  const nextSidebar = findSidebarRoot();
  if (!nextSidebar) {
    if (panel) cleanupInjectedProjects();
    if (pendingPanelRetryCount < PANEL_READY_RETRY_LIMIT) {
      pendingPanelRetryCount += 1;
      scheduleRescan(PANEL_READY_RETRY_MS);
    }
    return;
  }

  if (!isExpandedSidebar(nextSidebar)) {
    state.nativeConversationIds = new Set();
    state.nativeChatsReady = false;
    cleanupInjectedProjects();
    return;
  }

  if (sidebarRoot !== nextSidebar) {
    cleanupInjectedProjects();
    sidebarRoot = nextSidebar;
    sidebarObserver?.disconnect();
    sidebarObserver = new MutationObserver((mutations) => {
      const relevant = mutations.some((mutation) =>
        !(mutation.target instanceof HTMLElement && mutation.target.closest('#gemini-projects-host'))
      );
      if (relevant) scheduleRescan();
    });
    sidebarObserver.observe(sidebarRoot, { childList: true, subtree: true });
    pendingPanelRetryCount = 0;
  }

  if (!ensurePanel()) {
    if (pendingPanelRetryCount < PANEL_READY_RETRY_LIMIT) {
      pendingPanelRetryCount += 1;
      scheduleRescan(PANEL_READY_RETRY_MS);
    }
    return;
  }
  pendingPanelRetryCount = 0;
  ensureChatsList();
  syncNativeChatsFromDom();
  applyNativeChatVisibility();
  renderPanelIfChanged();
}

function installLifecycleRescans() {
  window.addEventListener('pageshow', () => scheduleRescan(0));
  window.addEventListener('focus', () => scheduleRescan(0));
  window.addEventListener('popstate', () => scheduleRescan(0));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      scheduleRescan(0);
    }
  });
}

function ensurePanel() {
  if (!sidebarRoot) return false;
  if (!isExpandedSidebar(sidebarRoot)) return false;
  const chats = findChatsSection(sidebarRoot);
  const { host, shadow, overlayShadow } = injectProjectsSection(sidebarRoot, chats);

  if (!panel || panelHost !== host) {
    panel?.destroy();
    panel = createProjectsPanel({
      shadow,
      overlayShadow,
      onSaveProject: handleSaveProject,
      onToggleProjectPin: handleToggleProjectPin,
      onToggleProjectExpand: handleToggleProjectExpand,
      onDeleteProject: handleDeleteProject,
      onToggleCollapse: handleToggleCollapse,
      onRemoveChatFromProject: (conversationId) => handleMoveChat(conversationId, null),
      onMoveChatToProject: handleMoveChat
    });
    panelHost = host;
    // Gemini 在 Chat 与 Spark 间切换时会替换内部滚动区但保留外层 bard-sidenav，
    // 新挂载的宿主必须强制渲染首帧。
    lastRenderKey = '';
  }

  if (chatMenuOverlayShadow !== overlayShadow) {
    detachChatMenu?.();
    detachChatMenu = attachChatMenuEnhancer({
      overlayShadow,
      getProjects: () => state.projects,
      getChatProjectId: (conversationId) => state.chatIndex.get(conversationId)?.projectId ?? null,
      onMoveChat: (conversationId, projectId) => {
        void handleMoveChat(conversationId, projectId).catch(showMoveError);
      },
      onCreateProject: () => panel?.openCreateModal()
    });
    chatMenuOverlayShadow = overlayShadow;
  }
  return true;
}

function ensureChatsList() {
  if (!sidebarRoot) return;
  const header = findChatsSection(sidebarRoot);
  if (!header) {
    clearDragFeedback();
    chatsList = null;
    chatsObserver?.disconnect();
    return;
  }

  const list = findChatsListContainer(header);
  if (!list) {
    clearDragFeedback();
    chatsList = null;
    chatsObserver?.disconnect();
    return;
  }
  if (list === chatsList) return;

  if (chatsList) clearDragFeedback();
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

  const updates: NativeChatMetadata[] = [];
  const nativeConversationIds = new Set<string>();
  for (const link of collectNativeChatLinks(chatsList)) {
    const conversationId = getConversationId(link.href);
    if (!conversationId) continue;
    nativeConversationIds.add(conversationId);

    const chat = readNativeMetadata(conversationId, link);
    const existing = state.chatIndex.get(conversationId);
    if (existing?.title !== chat.title || existing?.lastUrl !== chat.lastUrl) updates.push(chat);
  }
  state.nativeConversationIds = nativeConversationIds;
  state.nativeChatsReady = nativeConversationIds.size > 0;

  if (!stateReady || scanPending || !updates.length) return;
  scanPending = true;
  void sendMessage({ type: 'upsertChatRefs', chats: updates }).then((response) => {
    if (!response.ok) throw new Error(response.error);
  }).catch((error) => {
    console.warn('[gemini-projects] could not sync chat metadata', error);
  }).finally(() => { scanPending = false; });
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
  return Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href*="/app/"]')).filter((link) => {
    const id = getConversationId(link.href);
    if (!isSafeId(id) || !normalizeChatUrl(link.href, id)) return false;
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
  // 隐藏后的行没有布局尺寸，后续扫描继续使用已验证过的同一行。
  if (row.hasAttribute(HIDDEN_ATTR)) return row;

  const rect = row.getBoundingClientRect();
  const listRect = listRoot.getBoundingClientRect();
  if (rect.height <= 0 || rect.height > 96) return null;
  if (rect.width <= 0 || rect.width > listRect.width + 16) return null;

  const tag = row.tagName.toLowerCase();
  const role = row.getAttribute('role') || '';
  if (tag === 'li' || tag === 'gem-nav-list-item' || role === 'listitem') return row;

  const parentConversationCount = row.parentElement
    ? collectNativeChatLinks(row.parentElement).length
    : Number.POSITIVE_INFINITY;
  return parentConversationCount > 1 ? row : null;
}

async function handleSaveProject(project: Project, editing: boolean) {
  const response = await sendMessage({ type: 'upsertProject', project, editing });
  if (!response.ok) throw new Error(response.error);
}

function handleToggleProjectExpand(projectId: string) {
  if (state.expandedProjectIds.has(projectId)) {
    state.expandedProjectIds.delete(projectId);
  } else {
    state.expandedProjectIds.add(projectId);
  }
  renderPanelIfChanged(true);
}

async function handleToggleProjectPin(projectId: string, isPinned: boolean) {
  const response = await sendMessage({ type: 'setProjectPinned', projectId, isPinned });
  if (!response.ok) throw new Error(response.error);
}

function handleToggleCollapse(collapsed: boolean) {
  state.uiPrefs.projectsCollapsed = collapsed;
  sendMessage({ type: 'updateUiPrefs', prefs: { projectsCollapsed: collapsed } }).catch(() => undefined);
  renderPanelIfChanged(true);
}

async function handleDeleteProject(projectId: string) {
  const response = await sendMessage({ type: 'deleteProject', projectId });
  if (!response.ok || !response.state) return;
  state.expandedProjectIds.delete(projectId);
  applyNativeChatVisibility();
  renderPanelIfChanged(true);
}

async function handleMoveChat(conversationId: string, projectId: string | null) {
  const existing = state.chatIndex.get(conversationId);
  const link = !existing?.lastUrl ? findNativeLinkByConversationId(conversationId) : null;
  const metadata = link ? readNativeMetadata(conversationId, link) : undefined;
  const response = await sendMessage({ type: 'moveChat', conversationId, projectId, metadata });
  if (!response.ok) throw new Error(response.error);
}

function readNativeMetadata(conversationId: string, link: HTMLAnchorElement): NativeChatMetadata {
  const title = normalizeTitle(link.textContent || '') || state.chatIndex.get(conversationId)?.title || 'Untitled chat';
  return { conversationId, title, lastUrl: link.href };
}

function showMoveError(error: unknown) {
  console.warn('[gemini-projects] move failed', error);
  panel?.showToast('Could not move chat. Please try again.');
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

function clearUnassignHighlight() {
  unassignZone?.removeAttribute(DROP_UNASSIGN_ATTR);
  unassignZone = null;
}

function clearDragFeedback() {
  clearUnassignHighlight();
  nativeDragSource?.removeAttribute(DRAG_SOURCE_ATTR);
  nativeDragSource = null;
  panel?.clearDragFeedback();
  clearActiveDraggedChat();
}

function findUnassignZone(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element) || target.closest('#gemini-projects-host')) return null;
  if (chatsList?.contains(target)) return chatsList;
  const all = target.closest<HTMLElement>('.chat-history');
  return all && sidebarRoot?.contains(all) ? all : null;
}

function installNativeDragHandlers() {
  document.addEventListener('dragstart', (event) => {
    if (!chatsList) return;
    const target = event.target as HTMLElement | null;
    if (!target || target.closest('#gemini-projects-host')) return;
    if (!chatsList.contains(target)) return;

    const link = target.closest<HTMLAnchorElement>('a[href]') || target.querySelector<HTMLAnchorElement>('a[href]');
    const row = findChatRowElement(link || target, chatsList);
    const conversationId = (link?.href ? getConversationId(link.href) : null) || getConversationIdFromChatRow(row);
    if (!conversationId) return;

    clearDragFeedback();
    setActiveDraggedChat({ conversationId, sourceProjectId: null });
    nativeDragSource = row ?? link;
    nativeDragSource?.setAttribute(DRAG_SOURCE_ATTR, 'true');
    if (event.dataTransfer) {
      event.dataTransfer.setData('application/x-gemini-chat-id', conversationId);
      event.dataTransfer.effectAllowed = 'move';
    }
  });

  document.addEventListener('dragover', (event) => {
    const zone = getActiveDraggedChat()?.sourceProjectId ? findUnassignZone(event.target) : null;
    if (zone !== unassignZone) {
      clearUnassignHighlight();
      unassignZone = zone;
      zone?.setAttribute(DROP_UNASSIGN_ATTR, 'true');
    }
    if (zone) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    }
  });

  document.addEventListener('dragleave', (event) => {
    if (findUnassignZone(event.relatedTarget) !== unassignZone) clearUnassignHighlight();
  });

  document.addEventListener('drop', (event) => {
    const dragged = getActiveDraggedChat();
    const zone = findUnassignZone(event.target);
    clearDragFeedback();
    if (!dragged?.sourceProjectId || !zone) return;

    event.preventDefault();
    const sourcePanel = panel;
    handleMoveChat(dragged.conversationId, null)
      .then(() => {
        if (panel === sourcePanel) panel?.showToast('Removed from project');
      })
      .catch(showMoveError);
  });

  document.addEventListener('dragend', clearDragFeedback);
  window.addEventListener('blur', clearDragFeedback);
}

function installNativeHideStyle() {
  if (document.getElementById('gp-native-hide-style')) return;
  const style = document.createElement('style');
  style.id = 'gp-native-hide-style';
  style.textContent = `
    [${HIDDEN_ATTR}="true"] { display: none !important; }
    [${DRAG_SOURCE_ATTR}="true"] { opacity: 0.45; }
    [${DROP_UNASSIGN_ATTR}="true"] {
      box-shadow: inset 0 0 0 1.5px rgb(128 128 128 / .65);
      border-radius: 12px;
    }
  `;
  document.documentElement.appendChild(style);
}

function isExpandedSidebar(sidebar: HTMLElement): boolean {
  const rect = sidebar.getBoundingClientRect();
  const style = window.getComputedStyle(sidebar);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  if (rect.width < MIN_EXPANDED_SIDEBAR_WIDTH || rect.height <= 0) return false;
  if (rect.right <= 0 || rect.left >= window.innerWidth) return false;
  return true;
}

function isSparkSurface(): boolean {
  return window.location.pathname === '/spark' || window.location.pathname.startsWith('/spark/');
}

function cleanupInjectedProjects() {
  clearDragFeedback();
  detachChatMenu?.();
  detachChatMenu = null;
  panel?.destroy();
  panel = null;
  panelHost = null;
  chatMenuOverlayShadow = null;
  chatsList = null;
  chatsObserver?.disconnect();
  chatsObserver = null;
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
    .map((project) => `${project.id}:${project.name}:${project.icon}:${project.color || ''}:${project.sortIndex}:${project.isPinned === true}`)
    .join('|');
  const chats = Array.from(state.chatIndex.values())
    .filter((chat) => chat.projectId)
    .map((chat) => {
      const missing =
        state.nativeChatsReady &&
        chat.conversationId !== state.activeConversationId &&
        !state.nativeConversationIds.has(chat.conversationId);
      return `${chat.conversationId}:${chat.title}:${chat.projectId}:${chat.lastUrl || ''}:${chat.updatedAt}:${missing}`;
    })
    .sort()
    .join('|');
  return `${state.activeConversationId || ''}|${state.uiPrefs.projectsCollapsed}|${Array.from(state.expandedProjectIds).sort().join(',')}|${projects}|${chats}`;
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
