import { showSurface, hideSurface, setSurfaceOrigin } from '../ui/motion';
import { Project } from '../../shared/types';
import {
  findChatsListContainer,
  findChatsSection,
  findChatRowElement,
  findSidebarRoot,
  getConversationId,
  getConversationIdFromChatRow
} from './anchors';
import { renderIconSvg } from '../ui/icons';
import { PILL_RADIUS } from '../ui/radii';
import { resolveGeminiTheme } from '../ui/theme';

const ACTIVE_ROW_ATTR = 'data-gp-active-row';
const ACTIVE_ROW_ID_ATTR = 'data-gp-conversation-id';
const MENU_ITEM_ATTR = 'data-gp-item';
const MENU_OBSERVER_ATTR = 'data-gp-menu-observer';
const MENU_TOKENS = ['share conversation', 'share', 'pin', 'rename', 'delete', '分享', '置顶', '重命名', '删除'];
const PIN_ACTION_TOKENS = ['pin', '置顶', '置頂', '固定'];
const RENAME_ACTION_TOKENS = ['rename', '重命名', '重新命名'];
const DELETE_ACTION_TOKENS = ['delete', '删除', '刪除'];

interface ChatMenuEnhancerOptions {
  overlayShadow: ShadowRoot;
  getProjects: () => Project[];
  getChatProjectId: (conversationId: string) => string | null;
  onMoveChat: (conversationId: string, projectId: string | null) => void;
  onCreateProject: () => void;
}

let openMoveMenuHandler: ((anchor: DOMRect, conversationId: string, item: HTMLElement) => void) | null = null;
let closeMoveMenuHandler: (() => void) | null = null;
let keepMoveMenuOpenHandler: (() => void) | null = null;
let activeRowTimeout: number | null = null;
let listenersAttached = false;
let currentMenuRoot: HTMLElement | null = null;
let menuObserver: MutationObserver | null = null;
let submenuElement: HTMLElement | null = null;
let closeTimer: number | null = null;
let activeMoveItem: HTMLElement | null = null;

function hasMenuToken(container: HTMLElement, tokens: string[]): boolean {
  const nodes = container.querySelectorAll<HTMLElement>('div, button, [role="menuitem"]');
  for (const node of Array.from(nodes)) {
    const text = (node.textContent || '').toLowerCase();
    if (tokens.some((token) => text.includes(token))) {
      return true;
    }
  }
  return false;
}

function hasRequiredChatActions(container: HTMLElement): boolean {
  return (
    hasMenuToken(container, PIN_ACTION_TOKENS) &&
    hasMenuToken(container, RENAME_ACTION_TOKENS) &&
    hasMenuToken(container, DELETE_ACTION_TOKENS)
  );
}

function summarizeChatMenu(container: HTMLElement): {
  pin: boolean;
  rename: boolean;
  delete: boolean;
  recognizedActionCount: number;
} {
  const pin = hasMenuToken(container, PIN_ACTION_TOKENS);
  const rename = hasMenuToken(container, RENAME_ACTION_TOKENS);
  const deleteAction = hasMenuToken(container, DELETE_ACTION_TOKENS);
  return {
    pin,
    rename,
    delete: deleteAction,
    recognizedActionCount: [pin, rename, deleteAction].filter(Boolean).length
  };
}

function isRowInChatsList(row: HTMLElement | null): boolean {
  if (!row) return false;
  const sidebarRoot = findSidebarRoot();
  if (!sidebarRoot) return false;
  const chatsHeader = findChatsSection(sidebarRoot);
  if (!chatsHeader) return false;
  const chatsList = findChatsListContainer(chatsHeader);
  if (!chatsList) return false;
  return chatsList.contains(row);
}

function clearActiveRow() {
  const prev = document.querySelector<HTMLElement>(`[${ACTIVE_ROW_ATTR}="true"]`);
  if (prev) {
    prev.removeAttribute(ACTIVE_ROW_ATTR);
    prev.removeAttribute(ACTIVE_ROW_ID_ATTR);
  }
  if (activeRowTimeout) {
    window.clearTimeout(activeRowTimeout);
    activeRowTimeout = null;
  }
}

function setActiveRow(row: HTMLElement | null) {
  clearActiveRow();
  if (!row) return;
  row.setAttribute(ACTIVE_ROW_ATTR, 'true');
  activeRowTimeout = window.setTimeout(() => clearActiveRow(), 2000);
}

export function attachChatMenuEnhancer(options: ChatMenuEnhancerOptions) {
  const moveMenu = createMoveMenu(options);
  openMoveMenuHandler = (anchor, conversationId, item) => {
    moveMenu.setActiveItem(item);
    moveMenu.open(anchor, conversationId);
  };
  closeMoveMenuHandler = () => moveMenu.startCloseTimer();
  keepMoveMenuOpenHandler = () => moveMenu.cancelCloseTimer();

  if (listenersAttached) {
    return null;
  }
  listenersAttached = true;

  document.addEventListener(
    'pointerdown',
    (event) => {
      const target = event.target as HTMLElement | null;
      if (!target || !isChatKebabButton(target)) return;

      cleanupMenuArtifacts();

      const row = findChatRowFromTarget(target);
      setActiveRow(row);
      const conversationId = getConversationIdFromActiveRow(target);
      if (conversationId && row) {
        row.setAttribute(ACTIVE_ROW_ID_ATTR, conversationId);
      }

      waitForMenuRoot(target).then((menuRoot) => {
        if (!menuRoot) return;
        const resolvedId = conversationId || getConversationIdFromActiveRow(target);
        if (!resolvedId) return;
        tryInjectWithRetries(menuRoot, resolvedId, target, 0);
      });
    },
    true
  );

  document.addEventListener('click', (event) => {
    const path = event.composedPath();
    const target = event.target as HTMLElement | null;
    if (!target) return;

    const inSubmenu = !!submenuElement && path.includes(submenuElement);
    const inMenu = !!currentMenuRoot && (path.includes(currentMenuRoot) || currentMenuRoot.contains(target));
    const isKebab = isChatKebabButton(target);

    if (!inSubmenu && !inMenu && !isKebab) {
      cleanupMenuArtifacts();
    }
  });

  document.addEventListener('scroll', () => cleanupMenuArtifacts(), true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      cleanupMenuArtifacts();
    }
  });

  return () => {
    listenersAttached = false;
    openMoveMenuHandler = null;
    closeMoveMenuHandler = null;
    keepMoveMenuOpenHandler = null;
  };
}

export function isChatKebabButton(el: HTMLElement): boolean {
  const button = el.closest('button,[role="button"],div,[aria-label]') as HTMLElement | null;
  if (!button) return false;
  const row = findChatRowFromTarget(button);
  if (!isRowInChatsList(row)) {
    return false;
  }
  const conversationId = getConversationIdFromChatRow(row);
  if (!conversationId) {
    return false;
  }
  const labelRaw = button.getAttribute('aria-label') || button.getAttribute('title') || '';
  const label = labelRaw.toLowerCase();
  const hasMenuAttr = button.getAttribute('aria-haspopup') === 'menu' || button.getAttribute('aria-expanded') === 'true';
  const text = (button.textContent || '').trim();
  const hasDots = text === '⋮' || text === '...' || text === '…';
  const labelHit = [
    'more',
    'menu',
    'options',
    'open menu',
    'conversation actions',
    'open menu for conversation actions',
    '更多',
    '菜单',
    '选项',
    '菜單',
    '選單',
    '選項'
  ].some((token) => label.includes(token));
  return hasMenuAttr || hasDots || labelHit;
}

export function waitForMenuRoot(targetEl?: HTMLElement): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    let done = false;
    const resolveOnce = (menu: HTMLElement | null) => {
      if (done) return;
      done = true;
      observer.disconnect();
      resolve(menu);
    };

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of Array.from(mutation.addedNodes)) {
          const menu = findMenuFromNode(node);
          if (menu) {
            resolveOnce(menu);
            return;
          }
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    let frame = 0;
    const maxFrames = 30;
    const tick = () => {
      if (done) return;
      const menuRoot = findBestMenuRoot(targetEl);
      if (menuRoot) {
        resolveOnce(menuRoot);
        return;
      }
      frame += 1;
      if (frame >= maxFrames) {
        resolveOnce(null);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

function findMenuFromNode(node: Node): HTMLElement | null {
  if (!(node instanceof HTMLElement)) {
    return null;
  }
  if (isGeminiChatMenu(node)) {
    return node;
  }
  const roleMenu = node.querySelector<HTMLElement>('[role="menu"], [role="listbox"]');
  if (roleMenu && isGeminiChatMenu(roleMenu)) {
    return roleMenu;
  }
  const menuItem = node.querySelector<HTMLElement>('[role="menuitem"]');
  if (menuItem) {
    const root = menuItem.closest<HTMLElement>('[role="menu"], [role="listbox"]') || menuItem.parentElement;
    if (root && isGeminiChatMenu(root)) {
      return root;
    }
  }
  return null;
}

function collectSearchRoots(): (Document | ShadowRoot)[] {
  const roots: (Document | ShadowRoot)[] = [document];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let current = walker.currentNode as Element | null;
  while (current) {
    const element = current as HTMLElement;
    if (element.shadowRoot && element.id !== 'gemini-projects-overlay' && element.id !== 'gp-prompt-picker-root') {
      roots.push(element.shadowRoot);
    }
    current = walker.nextNode() as Element | null;
  }
  return roots;
}

function findBestMenuRoot(targetEl?: HTMLElement): HTMLElement | null {
  const roots = collectSearchRoots();
  const candidates: HTMLElement[] = [];

  roots.forEach((root) => {
    candidates.push(...Array.from(root.querySelectorAll<HTMLElement>('[role="menu"], [role="listbox"]')));
  });

  const visibleCandidates = candidates.filter((menu) => isMenuRootVisible(menu) && isGeminiChatMenu(menu));
  if (!visibleCandidates.length) return null;

  const byHits = visibleCandidates
    .map((menu) => {
      const rect = menu.getBoundingClientRect();
      const area = rect.width * rect.height;
      return { menu, hits: countMenuTokens(menu, MENU_TOKENS), area };
    })
    .sort((a, b) => {
      if (b.hits !== a.hits) return b.hits - a.hits;
      return a.area - b.area;
    });

  if (byHits[0]?.hits >= 2) {
    return byHits[0].menu;
  }

  if (targetEl) {
    const fromPoint = findMenuFromPoint(targetEl);
    if (fromPoint) return fromPoint;
    return pickClosestMenu(visibleCandidates, targetEl);
  }

  return pickTopmostMenu(visibleCandidates);
}

function findMenuFromPoint(targetEl: HTMLElement): HTMLElement | null {
  const rect = targetEl.getBoundingClientRect();
  const x = Math.min(window.innerWidth - 4, Math.max(0, rect.right + 8));
  const y = Math.min(window.innerHeight - 4, Math.max(0, rect.top + 8));
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!el) return null;
  const menu = el.closest<HTMLElement>('[role="menu"], [role="listbox"]');
  if (menu && isMenuRootVisible(menu) && isGeminiChatMenu(menu)) {
    return menu;
  }
  return null;
}

function pickClosestMenu(menus: HTMLElement[], targetEl: HTMLElement): HTMLElement | null {
  const targetRect = targetEl.getBoundingClientRect();
  let bestMenu: HTMLElement | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  menus.forEach((menu) => {
    const rect = menu.getBoundingClientRect();
    const dx = rect.left - targetRect.right;
    const dy = rect.top - targetRect.top;
    const distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestMenu = menu;
    }
  });
  return bestMenu;
}

function pickTopmostMenu(menus: HTMLElement[]): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestZ = -Infinity;
  menus.forEach((menu) => {
    const z = getZIndex(menu);
    if (z > bestZ) {
      bestZ = z;
      best = menu;
    }
  });
  return best || menus[0] || null;
}

function getZIndex(element: HTMLElement): number {
  const z = window.getComputedStyle(element).zIndex;
  const parsed = Number(z);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isGeminiChatMenu(root: HTMLElement): boolean {
  if (hasRequiredChatActions(root)) {
    return true;
  }
  const summary = summarizeChatMenu(root);
  return summary.recognizedActionCount >= 2 && (summary.pin || summary.rename || summary.delete);
}

export function getConversationIdFromActiveRow(targetEl: HTMLElement): string | null {
  const active = document.querySelector<HTMLElement>(`[${ACTIVE_ROW_ATTR}="true"]`);
  const row = active || findChatRowFromTarget(targetEl);
  const link = row?.querySelector<HTMLAnchorElement>('a[href]') || targetEl.closest<HTMLAnchorElement>('a[href]');
  const hrefId = link?.href ? getConversationId(link.href) : null;
  if (hrefId) return hrefId;
  if (row) {
    const cached = row.getAttribute(ACTIVE_ROW_ID_ATTR);
    if (cached) return cached;
  }
  return getConversationIdFromChatRow(row);
}

export function injectMoveToProject(root: HTMLElement, conversationId: string): boolean {
  if (!openMoveMenuHandler) return false;

  let menuRoot = findMenuContainer(root);
  menuRoot = findActualMenuRoot(menuRoot);
  if (menuRoot === document.body || menuRoot === document.documentElement || !isGeminiChatMenu(menuRoot)) {
    return false;
  }
  currentMenuRoot = menuRoot;

  queryAllInRoots(`[${MENU_ITEM_ATTR}="move-to-project"]`).forEach((node) => {
    if (!menuRoot.contains(node)) {
      node.remove();
    }
  });

  const existing = menuRoot.querySelector(`[${MENU_ITEM_ATTR}="move-to-project"]`);
  if (existing) {
    existing.remove();
  }

  const { container, deleteItem } = findMenuListContainer(menuRoot);
  if (!container || container === document.body || container === document.documentElement) {
    return false;
  }

  const item = document.createElement('div');
  item.setAttribute('role', 'menuitem');
  item.setAttribute(MENU_ITEM_ATTR, 'move-to-project');

  item.style.display = 'flex';
  item.style.alignItems = 'center';
  item.style.gap = '12px';
  item.style.setProperty('height', '32px', 'important');
  item.style.setProperty('min-height', '32px', 'important');
  item.style.setProperty('max-height', '32px', 'important');
  item.style.setProperty('padding', '0 12px', 'important');
  item.style.setProperty('margin', '2px 0', 'important');
  item.style.setProperty('box-sizing', 'border-box', 'important');
  item.style.setProperty('cursor', 'pointer', 'important');
  item.style.setProperty('border-radius', PILL_RADIUS, 'important');
  item.style.setProperty('background', 'transparent', 'important');
  item.style.setProperty('color', 'inherit', 'important');
  item.style.setProperty('border', 'none', 'important');
  item.style.setProperty('outline', 'none', 'important');
  item.style.setProperty('font-family', '"Google Sans Flex", "Google Sans", "Helvetica Neue", sans-serif', 'important');
  item.style.setProperty('font-size', '14px', 'important');
  item.style.setProperty('font-weight', '500', 'important');
  item.style.setProperty('line-height', '20px', 'important');

  const icon = document.createElement('span');
  icon.style.setProperty('width', '18px', 'important');
  icon.style.setProperty('height', '18px', 'important');
  icon.style.setProperty('flex', '0 0 18px', 'important');
  icon.style.display = 'inline-flex';
  icon.style.alignItems = 'center';
  icon.style.justifyContent = 'center';
  icon.innerHTML = `
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 2H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
      <path d="m12 10 3 3-3 3" />
      <path d="M15 13H8" />
    </svg>
  `;

  const label = document.createElement('span');
  label.textContent = 'Move to Project';
  label.style.flex = '1';

  const arrow = document.createElement('span');
  arrow.style.display = 'flex';
  arrow.style.alignItems = 'center';
  arrow.style.opacity = '0.6';
  arrow.innerHTML = `
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M10 17l5-5-5-5"/>
    </svg>
  `;

  item.appendChild(icon);
  item.appendChild(label);
  item.appendChild(arrow);

  item.addEventListener('mouseenter', () => {
    const hoverBg = resolveGeminiTheme() === 'dark' ? 'rgba(255, 255, 255, 0.08)' : '#f1f3f4';
    item.style.setProperty('background', hoverBg, 'important');
    keepMoveMenuOpenHandler?.();
    openMoveMenuHandler?.(item.getBoundingClientRect(), conversationId, item);
  });

  item.addEventListener('mouseleave', () => {
    item.style.setProperty('background', 'transparent', 'important');
    closeMoveMenuHandler?.();
  });

  item.addEventListener('click', () => {
    openMoveMenuHandler?.(item.getBoundingClientRect(), conversationId, item);
  });

  const insertParent = deleteItem?.parentNode || container;
  if (deleteItem?.parentNode) {
    deleteItem.parentNode.insertBefore(item, deleteItem.nextSibling);
  } else {
    insertParent.appendChild(item);
  }

  const ok = validateInjection(item, container);
  if (!ok.passed) {
    item.remove();
    return false;
  }

  observeMenuRoot(menuRoot, conversationId);
  return true;
}

function validateInjection(item: HTMLElement, menuRoot: HTMLElement): { passed: boolean; overlap: number } {
  const menuRect = menuRoot.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  const overlapArea = intersectionArea(menuRect, itemRect);
  const itemArea = Math.max(1, itemRect.width * itemRect.height);
  const overlap = overlapArea / itemArea;
  const passed = menuRoot.contains(item) && overlap >= 0.95;
  return { passed, overlap };
}

function intersectionArea(a: DOMRect, b: DOMRect): number {
  const x1 = Math.max(a.left, b.left);
  const y1 = Math.max(a.top, b.top);
  const x2 = Math.min(a.right, b.right);
  const y2 = Math.min(a.bottom, b.bottom);
  const w = Math.max(0, x2 - x1);
  const h = Math.max(0, y2 - y1);
  return w * h;
}

function observeMenuRoot(menuRoot: HTMLElement, conversationId: string) {
  if (menuRoot.getAttribute(MENU_OBSERVER_ATTR) === 'true') {
    return;
  }
  menuRoot.setAttribute(MENU_OBSERVER_ATTR, 'true');
  let reinjectCount = 0;

  if (menuObserver) {
    menuObserver.disconnect();
  }

  menuObserver = new MutationObserver(() => {
    if (!document.contains(menuRoot) || !isMenuRootVisible(menuRoot)) {
      menuObserver?.disconnect();
      menuRoot.removeAttribute(MENU_OBSERVER_ATTR);
      cleanupMenuArtifacts();
      return;
    }
    const exists = menuRoot.querySelector(`[${MENU_ITEM_ATTR}="move-to-project"]`);
    if (!exists && reinjectCount < 3) {
      reinjectCount += 1;
      injectMoveToProject(menuRoot, conversationId);
    }
  });

  menuObserver.observe(menuRoot, { childList: true, subtree: true });

  window.setTimeout(() => {
    menuObserver?.disconnect();
    menuRoot.removeAttribute(MENU_OBSERVER_ATTR);
  }, 800);
}

function isMenuRootVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  const inViewport =
    rect.width > 0 &&
    rect.height > 0 &&
    rect.right > 0 &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.top < window.innerHeight;
  const withinBounds = rect.width < window.innerWidth * 0.9 && rect.height < window.innerHeight * 0.9;
  const area = rect.width * rect.height;
  const style = window.getComputedStyle(element);
  return (
    inViewport &&
    withinBounds &&
    area > 2000 &&
    style.pointerEvents !== 'none' &&
    style.display !== 'none' &&
    style.visibility !== 'hidden'
  );
}

function findMenuContainer(root: HTMLElement): HTMLElement {
  if (isMenuRootVisible(root) && isGeminiChatMenu(root)) {
    return root;
  }
  const candidates = Array.from(root.querySelectorAll<HTMLElement>('div, button, [role="menuitem"]'));
  for (const node of candidates) {
    const text = (node.textContent || '').toLowerCase();
    if (!MENU_TOKENS.some((token) => text.includes(token))) {
      continue;
    }
    let current: HTMLElement | null = node.parentElement;
    while (current && current !== document.body) {
      if (isGeminiChatMenu(current) && isMenuRootVisible(current)) {
        return current;
      }
      current = current.parentElement;
    }
  }
  return root;
}

function countMenuTokens(container: HTMLElement, tokens: string[]): number {
  let count = 0;
  const nodes = container.querySelectorAll<HTMLElement>('div, button, [role="menuitem"]');
  nodes.forEach((node) => {
    const text = (node.textContent || '').toLowerCase();
    if (tokens.some((token) => text.includes(token))) {
      count += 1;
    }
  });
  return count;
}

function ensureSubmenuStyles(shadow: ShadowRoot) {
  if (shadow.querySelector('style[data-gp="move-submenu"]')) return;
  const style = document.createElement('style');
  style.dataset.gp = 'move-submenu';
  style.textContent = `
    .gp-move-menu {
      position: fixed;
      min-width: 220px;
      max-width: calc(100vw - 16px);
      max-height: calc(100vh - 16px);
      overflow-y: auto;
      box-sizing: border-box;
      padding: var(--gp-menu-inset, 8px);
      border-radius: var(--gp-radius-menu, 27px);
      background: var(--gp-surface, #ffffff);
      color: var(--gp-fg, #141413);
      border: 1px solid var(--gp-border, rgb(31 30 29 / .15));
      box-shadow: var(--gp-shadow, 0 24px 64px #14141324, 0 4px 12px #1414130a);
      font-family: var(--gp-font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      font-size: 14px;
      font-weight: 500;
      line-height: 20px;
      display: none;
      pointer-events: auto;
      z-index: 2147483647;
    }
    .gp-move-item {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: var(--gp-menu-item-height, 36px);
      padding: 0 12px;
      border-radius: var(--gp-radius-pill, ${PILL_RADIUS});
      box-sizing: border-box;
      cursor: pointer;
      color: var(--gp-fg, #141413);
      transition: background-color var(--gp-transition, .18s ease);
    }
    .gp-move-item:hover {
      background: var(--gp-bg-hover, #f5f4ed);
    }
    .gp-move-item svg {
      width: 18px;
      height: 18px;
      flex: 0 0 18px;
    }
    .gp-move-item span {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .gp-move-divider {
      height: 1px;
      background: var(--gp-border, rgb(31 30 29 / .15));
      margin: 4px 8px;
    }
  `;
  shadow.appendChild(style);
}

function createMoveMenu(options: ChatMenuEnhancerOptions) {
  function getOverlayLayer(): HTMLElement {
    ensureSubmenuStyles(options.overlayShadow);
    const layer = options.overlayShadow.getElementById('gp-overlay-layer') as HTMLElement | null;
    return layer || (options.overlayShadow as unknown as HTMLElement);
  }

  function ensureSubmenu(): HTMLElement {
    const layer = getOverlayLayer();
    if (submenuElement && layer.contains(submenuElement)) {
      return submenuElement;
    }
    submenuElement?.remove();
    submenuElement = document.createElement('div');
    submenuElement.className = 'gp-move-menu';
    submenuElement.setAttribute('role', 'menu');

    submenuElement.addEventListener('mouseenter', () => {
      cancelCloseTimer();
    });
    submenuElement.addEventListener('mouseleave', () => {
      startCloseTimer();
    });

    layer.appendChild(submenuElement);
    return submenuElement;
  }

  function buildMenu(conversationId: string) {
    const projects = options.getProjects();
    const currentProjectId = options.getChatProjectId(conversationId);

    const items = [
      `<div class="gp-move-item secondary" data-gp-move="new">${renderIconSvg('default')}<span>New Project</span></div>`,
      '<div class="gp-move-divider"></div>',
      ...projects.map(
        (project) =>
          `<div class="gp-move-item" data-gp-move="${project.id}">${renderIconSvg(project.icon, project.color)}<span>${escapeHtml(project.name)}</span></div>`
      )
    ];

    if (currentProjectId) {
      items.push('<div class="gp-move-divider"></div>');
      items.push('<div class="gp-move-item" data-gp-move="remove"><span>Remove from Project</span></div>');
    }

    const menu = ensureSubmenu();
    menu.innerHTML = items.join('');
  }

  function open(anchorRect: DOMRect, conversationId: string) {
    const menu = ensureSubmenu();
    buildMenu(conversationId);

    menu.style.display = 'block';
    menu.style.visibility = 'hidden';
    menu.style.left = '0px';
    menu.style.top = '0px';

    requestAnimationFrame(() => {
      if (!menu.isConnected) return;

      const menuWidth = menu.offsetWidth;
      const height = menu.offsetHeight;
      const left = anchorRect.right + menuWidth > window.innerWidth
        ? anchorRect.left - menuWidth
        : anchorRect.right;

      const padding = 8;
      let top = anchorRect.top;
      if (top + height + padding > window.innerHeight) {
        top = window.innerHeight - height - padding;
      }
      top = Math.max(padding, top);

      menu.style.left = `${Math.max(8, left)}px`;
      menu.style.top = `${top}px`;
      menu.style.visibility = 'visible';
      showSurface(menu, 'menu', 'block', () => setSurfaceOrigin(menu, anchorRect, Math.max(8, left), top));
    });

    menu.onclick = (event) => {
      const target = (event.target as HTMLElement).closest('[data-gp-move]') as HTMLElement | null;
      if (!target) return;
      const action = target.dataset.gpMove;
      if (action === 'new') {
        options.onCreateProject();
        cleanupMenuArtifacts();
        return;
      }
      if (action === 'remove') {
        options.onMoveChat(conversationId, null);
        cleanupMenuArtifacts();
        return;
      }
      options.onMoveChat(conversationId, action || null);
      cleanupMenuArtifacts();
    };
    document.addEventListener('mousemove', onDocMouseMove, true);
  }

  function close() {
    if (submenuElement) {
      const closingMenu = submenuElement;
      submenuElement = null;
      hideSurface(closingMenu, () => closingMenu.remove());
    }
    document.removeEventListener('mousemove', onDocMouseMove, true);
    activeMoveItem = null;
  }

  function onDocMouseMove(e: MouseEvent) {
    if (!submenuElement || !activeMoveItem) return;
    const path = e.composedPath();
    const inSubmenu = path.includes(submenuElement);
    const inItem = path.includes(activeMoveItem);

    if (!inSubmenu && !inItem) {
      startCloseTimer();
    } else {
      cancelCloseTimer();
    }
  }

  function startCloseTimer() {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => {
      close();
    }, 200);
  }

  function cancelCloseTimer() {
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  }

  function setActiveItem(item: HTMLElement) {
    activeMoveItem = item;
  }

  return { open, close, startCloseTimer, cancelCloseTimer, setActiveItem };
}

function cleanupMenuArtifacts() {
  const moveItems = Array.from(queryAllInRoots(`[${MENU_ITEM_ATTR}="move-to-project"]`));
  moveItems.forEach((node) => node.remove());

  if (submenuElement) {
    const closingMenu = submenuElement;
    submenuElement = null;
    hideSurface(closingMenu, () => closingMenu.remove());
  }

  if (menuObserver) {
    menuObserver.disconnect();
    menuObserver = null;
  }

  if (currentMenuRoot) {
    currentMenuRoot.removeAttribute(MENU_OBSERVER_ATTR);
    currentMenuRoot = null;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function findChatRowFromTarget(target: HTMLElement): HTMLElement | null {
  const sidebarRoot = findSidebarRoot();
  const chatsHeader = sidebarRoot ? findChatsSection(sidebarRoot) : null;
  const chatsList = findChatsListContainer(chatsHeader);
  const resolved = findChatRowElement(target, chatsList);
  if (resolved) return resolved;

  const anchor = target.closest('a[href]') as HTMLElement | null;
  if (anchor) {
    return (anchor.closest('[role="listitem"], li') as HTMLElement | null) ?? anchor;
  }
  let current: HTMLElement | null = target;
  while (current && current !== document.body) {
    if (current.querySelector('a[href]')) {
      return current;
    }
    current = current.parentElement;
  }
  return target.closest('[role="listitem"], li, div') as HTMLElement | null;
}

function findMenuListContainer(menuRoot: HTMLElement): { container: HTMLElement; deleteItem?: HTMLElement } {
  const items = Array.from(menuRoot.querySelectorAll<HTMLElement>('[role="menuitem"], button, div'));
  const deleteItem = items.find(
    (item) =>
      (item.textContent || '').toLowerCase().includes('delete') || (item.textContent || '').includes('删除')
  );
  if (deleteItem?.parentElement && menuRoot.contains(deleteItem.parentElement)) {
    return { container: deleteItem.parentElement, deleteItem };
  }
  const innerMenu = menuRoot.querySelector<HTMLElement>('[role="menu"], [role="listbox"]');
  if (innerMenu && innerMenu !== menuRoot && isMenuRootVisible(innerMenu)) {
    return { container: innerMenu };
  }
  const firstItem = items.find((item) => {
    const text = (item.textContent || '').trim();
    if (!text || text.length > 48) return false;
    const rect = item.getBoundingClientRect();
    return rect.height > 20 && rect.height < 80;
  });
  if (firstItem?.parentElement && menuRoot.contains(firstItem.parentElement)) {
    return { container: firstItem.parentElement };
  }
  return { container: menuRoot };
}

function findActualMenuRoot(root: HTMLElement): HTMLElement {
  if (root.getAttribute('role') === 'menu' || root.getAttribute('role') === 'listbox') {
    if (isGeminiChatMenu(root)) {
      return root;
    }
  }
  const candidates = Array.from(root.querySelectorAll<HTMLElement>('[role="menu"], [role="listbox"]'));
  const visible = candidates.filter((menu) => isMenuRootVisible(menu) && isGeminiChatMenu(menu));
  if (!visible.length) return root;

  const best = visible
    .map((menu) => {
      const rect = menu.getBoundingClientRect();
      return { menu, hits: countMenuTokens(menu, MENU_TOKENS), area: rect.width * rect.height };
    })
    .sort((a, b) => {
      if (b.hits !== a.hits) return b.hits - a.hits;
      return a.area - b.area;
    })[0];

  if (best && best.hits >= 1) {
    return best.menu;
  }
  return root;
}

function queryAllInRoots(selector: string): HTMLElement[] {
  const roots = collectSearchRoots();
  const results: HTMLElement[] = [];
  roots.forEach((root) => {
    results.push(...Array.from(root.querySelectorAll<HTMLElement>(selector)));
  });
  return results;
}

function tryInjectWithRetries(menuRoot: HTMLElement, conversationId: string, targetEl: HTMLElement, attempt: number) {
  const ok = injectMoveToProject(menuRoot, conversationId);
  if (ok) return;
  if (attempt >= 2) return;
  const nextRoot = findBestMenuRoot(targetEl) || menuRoot;
  requestAnimationFrame(() => tryInjectWithRetries(nextRoot, conversationId, targetEl, attempt + 1));
}
