import { Project } from '../../shared/types';
import { getConversationIdFromChatRow } from './anchors';
import { renderIconSvg } from '../ui/icons';

const DEBUG = true;
const ACTIVE_ROW_ATTR = 'data-gp-active-row';
const ACTIVE_ROW_ID_ATTR = 'data-gp-conversation-id';
const MENU_ITEM_ATTR = 'data-gp-item';
const MENU_DIVIDER_ATTR = 'data-gp-divider';
const MENU_OBSERVER_ATTR = 'data-gp-menu-observer';
const MENU_TOKENS = ['share conversation', 'share', 'pin', 'rename', 'delete', '分享', '置顶', '重命名', '删除'];

interface MenuTheme {
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  color: string;
  lineHeight: string;
  background: string;
  borderRadius: string;
  boxShadow: string;
  border: string;
  hover: string;
  divider: string;
  itemRadius: string;
  itemPadding: string;
  itemHeight: string;
  backdropFilter?: string;
}

const DEFAULT_MENU_THEME: MenuTheme = {
  fontFamily: '"Google Sans Flex", "Google Sans", "Helvetica Neue", sans-serif',
  fontSize: '14px',
  fontWeight: '500',
  color: '#1b1a18',
  lineHeight: '20px',
  background: '#fbfaf6',
  borderRadius: '20px',
  boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06), 0 12px 24px -4px rgba(0, 0, 0, 0.15)',
  border: '1px solid rgba(91, 89, 84, 0.08)',
  hover: 'rgba(68, 71, 70, 0.08)',
  divider: 'rgba(91, 89, 84, 0.08)',
  itemRadius: '14px',
  itemPadding: '4px 12px',
  itemHeight: 'auto'
};

const DARK_MENU_THEME: MenuTheme = {
  ...DEFAULT_MENU_THEME,
  background: '#1b1a18',
  color: '#ede9e0',
  border: '1px solid rgba(237, 233, 224, 0.16)',
  boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.4), 0 12px 24px -4px rgba(0, 0, 0, 0.5)',
  hover: 'rgba(237, 233, 224, 0.08)',
  divider: 'rgba(237, 233, 224, 0.16)'
};

let currentMenuTheme: MenuTheme = { ...DEFAULT_MENU_THEME };

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

function log(...args: unknown[]) {
  if (DEBUG) {
    // eslint-disable-next-line no-console
    console.log('[gp-menu]', ...args);
  }
}

function describeEl(el: HTMLElement | null): string {
  if (!el) return 'null';
  const label = el.getAttribute('aria-label') || '';
  const role = el.getAttribute('role') || '';
  const text = (el.textContent || '').trim().slice(0, 24);
  return `${el.tagName.toLowerCase()} role=${role} label=${label} text="${text}"`;
}

function menuRectInfo(el: HTMLElement): string {
  const rect = el.getBoundingClientRect();
  return `${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}`;
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

log('menus.ts debug enabled');

export function attachChatMenuEnhancer(options: ChatMenuEnhancerOptions) {
  const moveMenu = createMoveMenu(options);
  openMoveMenuHandler = (anchor, conversationId, item) => {
    moveMenu.setActiveItem(item);
    moveMenu.open(anchor, conversationId);
  };

  if (listenersAttached) {
    return null;
  }
  listenersAttached = true;

  document.addEventListener(
    'pointerdown',
    (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const inSidebar = !!target.closest('nav, aside, [role="navigation"], [role="complementary"]');
      if (inSidebar) {
        log('pointerdown', describeEl(target));
      }
      if (!isChatKebabButton(target)) {
        if (inSidebar) {
          log('not a kebab', describeEl(target.closest('button,[role="button"],div,[aria-label]') as HTMLElement));
        }
        return;
      }

      cleanupMenuArtifacts('new menu');

      const row = findChatRowFromTarget(target);
      setActiveRow(row);
      log('kebab click captured');
      const conversationId = getConversationIdFromActiveRow(target);
      log('conversationId', conversationId);
      if (!conversationId) {
        log('conversationId missing at click');
      } else if (row) {
        row.setAttribute(ACTIVE_ROW_ID_ATTR, conversationId);
      }

      waitForMenuRoot(target).then((menuRoot) => {
        if (!menuRoot) {
          log('menu root not found');
          return;
        }
        log('menuRoot found:', menuRoot.tagName.toLowerCase(), 'rect=', menuRectInfo(menuRoot), 'hits=', countMenuTokens(menuRoot, MENU_TOKENS));
        const resolvedId = conversationId || getConversationIdFromActiveRow(target);
        if (!resolvedId) {
          log('conversationId missing at inject time');
          return;
        }
        tryInjectWithRetries(menuRoot, resolvedId, target, 0);
      });
    },
    true
  );

  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    const inSubmenu = submenuElement?.contains(target) ?? false;
    const inMenu = currentMenuRoot?.contains(target) ?? false;
    const isKebab = isChatKebabButton(target);

    if (!inSubmenu && !inMenu && !isKebab) {
      cleanupMenuArtifacts('outside click');
    }
  });

  document.addEventListener('scroll', () => cleanupMenuArtifacts('scroll'), true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      cleanupMenuArtifacts('esc');
    }
  });

  return () => {
    listenersAttached = false;
    openMoveMenuHandler = null;
  };
}

export function isChatKebabButton(el: HTMLElement): boolean {
  const button = el.closest('button,[role="button"],div,[aria-label]') as HTMLElement | null;
  if (!button) return false;
  const row = findChatRowFromTarget(button);
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
    '选项'
  ].some((token) => label.includes(token));
  const hasAnchor = !!row?.querySelector?.('a[href]');
  const inSidebar = !!button.closest('nav, aside, [role="navigation"], [role="complementary"]');
  if (labelHit && inSidebar) return true;
  return (hasMenuAttr || hasDots || labelHit) && (hasAnchor || inSidebar);
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
    if (element.shadowRoot) {
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

  const visibleCandidates = candidates.filter((menu) => isMenuRootVisible(menu));
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
  if (menu && isMenuRootVisible(menu)) {
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
  const hits = countMenuTokens(root, MENU_TOKENS);
  if (hits >= 2) return true;
  const items = root.querySelectorAll('[role="menuitem"], button, div');
  return (root.getAttribute('role') === 'menu' || root.getAttribute('role') === 'listbox') && items.length >= 3 && items.length <= 12;
}

export function getConversationIdFromActiveRow(targetEl: HTMLElement): string | null {
  const active = document.querySelector<HTMLElement>(`[${ACTIVE_ROW_ATTR}="true"]`);
  const row = active || findChatRowFromTarget(targetEl);
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
  if (menuRoot === document.body || menuRoot === document.documentElement) {
    return false;
  }
  currentMenuRoot = menuRoot;

  // Clean stale items outside menuRoot
  queryAllInRoots(`[${MENU_ITEM_ATTR}="move-to-project"]`).forEach((node) => {
    if (!menuRoot.contains(node)) {
      node.remove();
    }
  });
  queryAllInRoots(`[${MENU_DIVIDER_ATTR}="move-to-project"]`).forEach((node) => {
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

  // Divider removed as per user request

  const item = document.createElement('div');
  item.setAttribute('role', 'menuitem');
  item.setAttribute(MENU_ITEM_ATTR, 'move-to-project');

  // ========================================
  // PIXEL-PERFECT NATIVE ALIGNMENT
  // Extracted from DevTools:
  // - Native button: 280 × 40, padding: 0 12px
  // - Icon: 20 × 20
  // - Font: 14px "Google Sans Flex", weight 500
  // ========================================

  item.style.display = 'flex';
  item.style.alignItems = 'center';
  item.style.gap = '12px';

  // Force styles with !important to override potential host conflicts
  item.style.setProperty('height', '32px', 'important');
  item.style.setProperty('min-height', '32px', 'important');
  item.style.setProperty('max-height', '32px', 'important');
  item.style.setProperty('padding', '0 12px', 'important');
  item.style.setProperty('margin', '2px 0', 'important');
  item.style.setProperty('box-sizing', 'border-box', 'important');
  item.style.setProperty('cursor', 'pointer', 'important');
  item.style.setProperty('border-radius', '8px', 'important');
  item.style.setProperty('background', 'transparent', 'important');
  // Use inherit to match native menu text color (Auto Dark Mode)
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
    const isDark = document.body.classList.contains('dark') || document.body.classList.contains('dark-theme');
    item.style.background = (isDark ? DARK_MENU_THEME : DEFAULT_MENU_THEME).hover;
    keepMoveMenuOpenHandler?.();
    openMoveMenuHandler?.(item.getBoundingClientRect(), conversationId, item);
  });

  item.addEventListener('mouseleave', () => {
    item.style.background = 'transparent';
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

  const menuRect = menuRoot.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  log('menuRoot rect=', `${Math.round(menuRect.left)},${Math.round(menuRect.top)} ${Math.round(menuRect.width)}x${Math.round(menuRect.height)}`);
  log('injected item height=', Math.round(itemRect.height), 'rect=', `${Math.round(itemRect.left)},${Math.round(itemRect.top)} ${Math.round(itemRect.width)}x${Math.round(itemRect.height)}`);

  const ok = validateInjection(item, container);
  log('injected ok:', `inRoot=${menuRoot.contains(item)}`, `overlap=${ok.overlap.toFixed(2)}`, `container=${describeEl(container)}`);

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
      cleanupMenuArtifacts('menu root gone');
      return;
    }
    const exists = menuRoot.querySelector(`[${MENU_ITEM_ATTR}="move-to-project"]`);
    if (!exists && reinjectCount < 3) {
      reinjectCount += 1;
      log('reinjected (observer) count=', reinjectCount);
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
  if (isMenuRootVisible(root) && countMenuTokens(root, MENU_TOKENS) >= 2) {
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
      if (countMenuTokens(current, MENU_TOKENS) >= 2 && isMenuRootVisible(current)) {
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

function createMoveMenu(options: ChatMenuEnhancerOptions) {
  function ensureSubmenu(): HTMLElement {
    if (submenuElement && document.contains(submenuElement)) {
      applySubmenuTheme(submenuElement);
      return submenuElement;
    }
    submenuElement = document.createElement('div');
    submenuElement.className = 'gp-move-menu';
    submenuElement.style.position = 'fixed';
    submenuElement.style.minWidth = '220px';
    applySubmenuTheme(submenuElement);
    submenuElement.style.padding = '6px';
    submenuElement.style.display = 'none';
    submenuElement.style.pointerEvents = 'auto';
    submenuElement.style.zIndex = '2147483647';

    // Auto-close handling on submenu itself
    submenuElement.addEventListener('mouseenter', () => {
      cancelCloseTimer();
    });
    submenuElement.addEventListener('mouseleave', () => {
      startCloseTimer();
    });

    document.body.appendChild(submenuElement);
    return submenuElement;
  }

  function applySubmenuTheme(menu: HTMLElement) {
    // Detect Dark Mode
    const isDark = document.body.classList.contains('dark-theme') ||
      document.body.classList.contains('dark');

    const theme = isDark ? DARK_MENU_THEME : DEFAULT_MENU_THEME;
    // Update global currentMenuTheme for buildMenu usage
    currentMenuTheme = { ...theme };

    // Enforce Premium Glass Theme for the submenu container
    menu.style.background = theme.background;
    menu.style.backdropFilter = theme.backdropFilter || '';
    // (menu.style as any).webkitBackdropFilter = DEFAULT_MENU_THEME.backdropFilter || ''; // Removed to fix lint
    menu.style.borderRadius = theme.borderRadius;
    menu.style.boxShadow = theme.boxShadow;
    menu.style.border = theme.border;

    // Use captured font metrics to ensure readable scale, but prefer our premium font stack
    menu.style.fontFamily = theme.fontFamily;
    menu.style.fontSize = theme.fontSize; // Match size
    menu.style.fontWeight = theme.fontWeight;
    menu.style.color = theme.color;

    // Animation for open
    menu.style.transformOrigin = 'top left';
    menu.style.animation = 'gp-scale-in 0.18s cubic-bezier(0.2, 0, 0.13, 1.5)';

    if (!document.getElementById('gp-submenu-styles')) {
      const style = document.createElement('style');
      style.id = 'gp-submenu-styles';
      style.textContent = `
        @keyframes gp-scale-in {
          from { opacity: 0; transform: scale(0.95); }
          to { opacity: 1; transform: scale(1); }
        }
      `;
      document.head.appendChild(style);
    }
  }

  function buildMenu(conversationId: string) {
    const projects = options.getProjects();
    const currentProjectId = options.getChatProjectId(conversationId);

    const items = [
      `<div class="gp-move-item secondary" data-gp-move="new">${renderIconSvg('default', '#5b5954')}<span>New Project</span></div>`,
      '<div class="gp-move-divider"></div>',
      ...projects.map(
        (project) =>
          `<div class="gp-move-item" data-gp-move="${project.id}">${renderIconSvg(project.icon, project.color || '#5b5954')}<span>${escapeHtml(project.name)}</span></div>`
      )
    ];

    if (currentProjectId) {
      items.push('<div class="gp-move-divider"></div>');
      items.push('<div class="gp-move-item" data-gp-move="remove">Remove from Project</div>');
    }

    const menu = ensureSubmenu();
    menu.innerHTML = items.join('');

    menu.querySelectorAll<HTMLElement>('.gp-move-item').forEach((item) => {
      item.style.display = 'flex';
      item.style.alignItems = 'center';
      item.style.gap = '12px';
      item.style.padding = currentMenuTheme.itemPadding;
      // item.style.height = DEFAULT_MENU_THEME.itemHeight; // Removed fixed height
      item.style.minHeight = '32px'; // Compact
      item.style.borderRadius = currentMenuTheme.itemRadius;
      item.style.cursor = 'pointer';
      item.style.fontSize = currentMenuTheme.fontSize;
      item.style.fontWeight = currentMenuTheme.fontWeight;
      item.style.color = currentMenuTheme.color;
      item.style.lineHeight = currentMenuTheme.lineHeight;
      item.style.fontFamily = currentMenuTheme.fontFamily;
      item.style.transition = 'all 0.18s ease';
      item.addEventListener('mouseenter', () => {
        item.style.background = currentMenuTheme.hover;
        // item.style.transform = 'scale(1.02)'; // Removed pop effect to fix radius alignment
      });
      item.addEventListener('mouseleave', () => {
        item.style.background = 'transparent';
        item.style.transform = 'none';
      });
    });

    menu.querySelectorAll<HTMLElement>('.gp-move-divider').forEach((item) => {
      item.style.height = '1px';
      item.style.background = currentMenuTheme.divider;
      item.style.margin = '4px 6px';
    });

    menu.querySelectorAll<SVGElement>('.gp-move-item svg').forEach((icon) => {
      icon.setAttribute('width', '18');
      icon.setAttribute('height', '18');
    });
  }

  function open(anchorRect: DOMRect, conversationId: string) {
    const menu = ensureSubmenu();
    buildMenu(conversationId);

    // 1. Prepare for measurement (visible in layout, hidden from user)
    menu.style.display = 'block';
    menu.style.visibility = 'hidden';
    menu.style.left = '0px';
    menu.style.top = '0px';

    // 2. Wait for next frame to ensure layout stability (fix for "drift" issue)
    requestAnimationFrame(() => {
      if (!menu.isConnected) return; // Menu closed during wait

      const menuWidth = 240; // match minWidth
      const height = menu.offsetHeight;

      // 3. Calculate position
      // Gap 0 for seamless transition
      const left = anchorRect.right + menuWidth > window.innerWidth
        ? anchorRect.left - menuWidth
        : anchorRect.right;

      // Vertical alignment: Top-align by default, Bottom-align if overflow
      const padding = 8;
      let top = anchorRect.top;

      if (top + height + padding > window.innerHeight) {
        // If overflows bottom, align bottom to viewport bottom (minus padding)
        top = window.innerHeight - height - padding;
      }
      // Also check top overflow just in case
      top = Math.max(padding, top);

      menu.style.left = `${Math.max(8, left)}px`;
      menu.style.top = `${top}px`;
      menu.style.visibility = 'visible'; // Show final result

      const rect = menu.getBoundingClientRect();
      log('submenu opened (stable)', Math.round(rect.left), Math.round(rect.top), 'size=', Math.round(rect.width), 'x', Math.round(rect.height));
    });

    menu.onclick = (event) => {
      const target = (event.target as HTMLElement).closest('[data-gp-move]') as HTMLElement | null;
      if (!target) return;
      const action = target.dataset.gpMove;
      if (action === 'new') {
        options.onCreateProject();
        cleanupMenuArtifacts('submenu new');
        return;
      }
      if (action === 'remove') {
        options.onMoveChat(conversationId, null);
        cleanupMenuArtifacts('submenu remove');
        return;
      }
      options.onMoveChat(conversationId, action || null);
      cleanupMenuArtifacts('submenu select');
    };
    document.addEventListener('mousemove', onDocMouseMove, true);
  }

  function close() {
    if (submenuElement) {
      submenuElement.remove();
      submenuElement = null;
    }
    document.removeEventListener('mousemove', onDocMouseMove, true);
    activeMoveItem = null;
  }

  function onDocMouseMove(e: MouseEvent) {
    if (!submenuElement || !activeMoveItem) return;
    const target = e.target as Node;
    const inSubmenu = submenuElement.contains(target);
    const inItem = activeMoveItem.contains(target);

    // If we are strictly outside both, ensure timer is running
    if (!inSubmenu && !inItem) {
      startCloseTimer();
    } else {
      cancelCloseTimer();
    }
  }

  function contains(target: HTMLElement) {
    return submenuElement?.contains(target) ?? false;
  }

  function startCloseTimer() {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => {
      close();
    }, 200); // 200ms grace period
  }

  function cancelCloseTimer() {
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  }

  // Expose setActiveItem for mouse tracking
  function setActiveItem(item: HTMLElement) {
    activeMoveItem = item;
  }

  return { open, close, contains, startCloseTimer, cancelCloseTimer, setActiveItem };
}

function cleanupMenuArtifacts(reason: string) {
  const moveItems = Array.from(queryAllInRoots(`[${MENU_ITEM_ATTR}="move-to-project"]`));
  const dividers = Array.from(queryAllInRoots(`[${MENU_DIVIDER_ATTR}="move-to-project"]`));
  moveItems.forEach((node) => node.remove());
  dividers.forEach((node) => node.remove());

  let removedSubmenu = 0;
  if (submenuElement) {
    submenuElement.remove();
    submenuElement = null;
    removedSubmenu = 1;
  }

  if (menuObserver) {
    menuObserver.disconnect();
    menuObserver = null;
  }

  if (currentMenuRoot) {
    currentMenuRoot.removeAttribute(MENU_OBSERVER_ATTR);
    currentMenuRoot = null;
  }

  log('cleanup removed:', `moveItem=${moveItems.length}`, `divider=${dividers.length}`, `submenu=${removedSubmenu}`, reason);
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
  const anchor = target.closest('a[href]') as HTMLElement | null;
  if (anchor) {
    return (anchor.closest('[role="listitem"], li, div') as HTMLElement | null) ?? anchor;
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
    if (!text) return false;
    if (text.length > 48) return false;
    const rect = item.getBoundingClientRect();
    return rect.height > 20 && rect.height < 80;
  });
  if (firstItem?.parentElement && menuRoot.contains(firstItem.parentElement)) {
    return { container: firstItem.parentElement };
  }
  return { container: menuRoot };
}

function pickMenuItemForStyle(container: HTMLElement): HTMLElement | null {
  const candidates = Array.from(container.querySelectorAll<HTMLElement>('[role="menuitem"], button, div'));
  for (const item of candidates) {
    const text = (item.textContent || '').trim();
    if (!text) continue;
    const rect = item.getBoundingClientRect();
    if (rect.height >= 28 && rect.height <= 60) {
      return item;
    }
  }
  return null;
}

function findActualMenuRoot(root: HTMLElement): HTMLElement {
  if (root.getAttribute('role') === 'menu' || root.getAttribute('role') === 'listbox') {
    if (countMenuTokens(root, MENU_TOKENS) >= 2) {
      return root;
    }
  }
  const candidates = Array.from(root.querySelectorAll<HTMLElement>('[role="menu"], [role="listbox"]'));
  const visible = candidates.filter((menu) => isMenuRootVisible(menu));
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
  if (attempt >= 2) {
    log('inject failed after retries');
    return;
  }
  const nextRoot = findBestMenuRoot(targetEl) || menuRoot;
  requestAnimationFrame(() => tryInjectWithRetries(nextRoot, conversationId, targetEl, attempt + 1));
}

function applySubmenuTheme(menu: HTMLElement) {
  // Enforce Premium Glass Theme for the submenu container
  menu.style.background = DEFAULT_MENU_THEME.background;
  menu.style.backdropFilter = DEFAULT_MENU_THEME.backdropFilter || '';
  menu.style.setProperty('-webkit-backdrop-filter', DEFAULT_MENU_THEME.backdropFilter || ''); // Safari support
  menu.style.borderRadius = DEFAULT_MENU_THEME.borderRadius;
  menu.style.boxShadow = DEFAULT_MENU_THEME.boxShadow;
  menu.style.border = DEFAULT_MENU_THEME.border;

  // Use captured font metrics to ensure readable scale, but prefer our premium font stack
  menu.style.fontFamily = DEFAULT_MENU_THEME.fontFamily;
  menu.style.fontSize = currentMenuTheme.fontSize; // Match size
  menu.style.fontWeight = DEFAULT_MENU_THEME.fontWeight;
  menu.style.color = DEFAULT_MENU_THEME.color;

  // Animation for open
  menu.style.transformOrigin = 'top left';
  menu.style.animation = 'gp-scale-in 0.15s cubic-bezier(0.2, 0, 0.13, 1.5)';

  if (!document.getElementById('gp-submenu-styles')) {
    const style = document.createElement('style');
    style.id = 'gp-submenu-styles';
    style.textContent = `
      @keyframes gp-scale-in {
        from { opacity: 0; transform: scale(0.95); }
        to { opacity: 1; transform: scale(1); }
      }
    `;
    document.head.appendChild(style);
  }
}

function captureMenuTheme(menuRoot: HTMLElement, styleSource: HTMLElement | null) {
  const menuStyle = window.getComputedStyle(menuRoot);
  const itemStyle = styleSource ? window.getComputedStyle(styleSource) : menuStyle;
  const itemRect = styleSource ? styleSource.getBoundingClientRect() : null;

  const background = normalizeColor(menuStyle.backgroundColor) || DEFAULT_MENU_THEME.background;
  const borderRadius = normalizeRadius(menuStyle.borderRadius) || DEFAULT_MENU_THEME.borderRadius;
  const boxShadow = menuStyle.boxShadow !== 'none' ? menuStyle.boxShadow : DEFAULT_MENU_THEME.boxShadow;
  const border = buildBorder(menuStyle);
  const itemRadius = normalizeRadius(itemStyle.borderRadius) || DEFAULT_MENU_THEME.itemRadius;
  const itemPadding = normalizePadding(itemStyle) || DEFAULT_MENU_THEME.itemPadding;
  const itemHeight = itemRect && itemRect.height > 0 ? `${Math.round(itemRect.height)}px` : DEFAULT_MENU_THEME.itemHeight;

  currentMenuTheme = {
    fontFamily: itemStyle.fontFamily || DEFAULT_MENU_THEME.fontFamily,
    fontSize: itemStyle.fontSize || DEFAULT_MENU_THEME.fontSize,
    fontWeight: itemStyle.fontWeight || DEFAULT_MENU_THEME.fontWeight,
    color: normalizeColor(itemStyle.color) || DEFAULT_MENU_THEME.color,
    lineHeight: normalizeLineHeight(itemStyle.lineHeight) || DEFAULT_MENU_THEME.lineHeight,
    background,
    borderRadius,
    boxShadow,
    border,
    hover: DEFAULT_MENU_THEME.hover,
    divider: DEFAULT_MENU_THEME.divider,
    itemRadius,
    itemPadding,
    itemHeight
  };
}

function normalizeColor(value: string): string {
  if (!value) return '';
  const normalized = value.trim().toLowerCase();
  if (normalized === 'transparent' || normalized === 'rgba(0, 0, 0, 0)') {
    return '';
  }
  return value;
}

function normalizeRadius(value: string): string {
  if (!value) return '';
  if (value === '0px') return '';
  return value;
}

function normalizeLineHeight(value: string): string {
  if (!value) return '';
  if (value === 'normal') return '';
  return value;
}

function normalizePadding(style: CSSStyleDeclaration): string {
  const top = style.paddingTop;
  const right = style.paddingRight;
  const bottom = style.paddingBottom;
  const left = style.paddingLeft;
  if (!top || !right || !bottom || !left) {
    return '';
  }
  if (top === '0px' && right === '0px' && bottom === '0px' && left === '0px') {
    return '';
  }
  return `${top} ${right} ${bottom} ${left}`;
}

function buildBorder(style: CSSStyleDeclaration): string {
  const width = style.borderWidth;
  const borderStyle = style.borderStyle;
  const color = normalizeColor(style.borderColor);
  if (width && width !== '0px' && borderStyle && borderStyle !== 'none' && color) {
    return `${width} ${borderStyle} ${color}`;
  }
  return DEFAULT_MENU_THEME.border;
}
