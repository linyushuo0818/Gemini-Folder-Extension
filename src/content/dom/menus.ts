import { showSurface, setSurfaceOrigin } from '../ui/motion';
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

const MENU_ITEM_ATTR = 'data-gp-item';
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

export function attachChatMenuEnhancer(options: ChatMenuEnhancerOptions): () => void {
  const lifecycle = new AbortController();
  let session: AbortController | null = null;
  let nativeMenu: HTMLElement | null = null;
  let trigger: HTMLElement | null = null;
  let kebab: HTMLElement | null = null;
  let submenu: HTMLElement | null = null;
  let closeTimer: number | undefined;

  function cancelClose() {
    window.clearTimeout(closeTimer);
    closeTimer = undefined;
  }

  function closeSubmenu(restoreFocus = false) {
    cancelClose();
    submenu?.remove();
    submenu = null;
    trigger?.setAttribute('aria-expanded', 'false');
    trigger?.style.setProperty('background', 'transparent', 'important');
    if (restoreFocus && trigger?.isConnected) trigger.focus({ preventScroll: true });
  }

  function close(restoreFocus = false) {
    closeSubmenu();
    session?.abort();
    session = null;
    trigger?.remove();
    trigger = null;
    nativeMenu = null;
    if (restoreFocus && kebab?.isConnected) kebab.focus({ preventScroll: true });
    kebab = null;
  }

  function scheduleClose() {
    cancelClose();
    closeTimer = window.setTimeout(() => {
      if (!submenu?.contains(options.overlayShadow.activeElement)) closeSubmenu();
    }, 200);
  }

  function openSubmenu(item: HTMLElement, conversationId: string, keyboard: boolean) {
    cancelClose();
    if (submenu) {
      if (keyboard) submenu.querySelector('button')?.focus();
      return;
    }
    ensureSubmenuStyles(options.overlayShadow);
    const menu = document.createElement('div');
    menu.className = 'gp-move-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Move to Project');
    submenu = menu;
    trigger?.setAttribute('aria-expanded', 'true');
    trigger?.style.setProperty('background', resolveGeminiTheme() === 'dark' ? 'rgba(255, 255, 255, 0.08)' : '#f1f3f4', 'important');
    const layer = options.overlayShadow.getElementById('gp-overlay-layer') ?? options.overlayShadow;
    layer.appendChild(menu);

    function addAction(label: string, icon: string, action: () => void) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'gp-move-item';
      button.setAttribute('role', 'menuitem');
      button.innerHTML = icon;
      const text = document.createElement('span');
      text.textContent = label;
      button.appendChild(text);
      button.onclick = () => {
        const nativeButton = kebab;
        if (nativeButton?.getAttribute('aria-expanded') === 'true') nativeButton.click();
        close(true);
        action();
      };
      menu.appendChild(button);
    }

    addAction('New Project', renderIconSvg('default'), options.onCreateProject);
    const current = options.getChatProjectId(conversationId);
    for (const project of options.getProjects()) {
      if (project.id === current) continue;
      addAction(project.name, renderIconSvg(project.icon, project.color),
        () => options.onMoveChat(conversationId, project.id));
    }
    if (current) addAction('Remove from Project', '', () => options.onMoveChat(conversationId, null));

    menu.onmouseenter = cancelClose;
    menu.onmouseleave = scheduleClose;
    menu.onkeydown = (event) => {
      if (event.key === 'Escape' || event.key === 'ArrowLeft') {
        event.preventDefault();
        event.stopPropagation();
        closeSubmenu(true);
      } else if (event.key === 'Tab') {
        closeSubmenu(true);
      } else {
        moveMenuFocus(menu, event);
      }
    };
    showSurface(menu, 'menu', 'block', () => {
      const anchor = item.getBoundingClientRect();
      const left = Math.max(8, Math.min(
        anchor.right + menu.offsetWidth <= window.innerWidth - 8 ? anchor.right : anchor.left - menu.offsetWidth,
        window.innerWidth - menu.offsetWidth - 8
      ));
      const top = Math.max(8, Math.min(anchor.top, window.innerHeight - menu.offsetHeight - 8));
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
      setSurfaceOrigin(menu, anchor, left, top);
    });
    if (keyboard) menu.querySelector('button')?.focus();
  }

  function begin(target: Element) {
    const button = target.closest<HTMLElement>('button, [role="button"], [aria-haspopup]');
    if (!button || !isChatKebabButton(button)) return;
    close();
    const row = findChatRowFromTarget(button);
    const href = row?.querySelector<HTMLAnchorElement>('a[href*="/app/"]')?.href;
    const conversationId = getConversationId(href) ?? getConversationIdFromChatRow(row);
    if (!conversationId) return;

    kebab = button;
    const controller = new AbortController();
    session = controller;
    const { signal } = controller;
    let frame = 0;
    let attempts = 0;
    const findAndInject = () => {
      const root = findBestMenuRoot(button);
      if (root) {
        nativeMenu = findActualMenuRoot(findMenuContainer(root));
        trigger = injectMoveToProject(nativeMenu, {
          open: (item, keyboard) => openSubmenu(item, conversationId, keyboard),
          leave: scheduleClose,
          close
        });
        if (trigger) {
          const observer = new MutationObserver(() => {
            // Gemini 的菜单容器可在可见时被设为 pointer-events: none。
            if (!trigger?.isConnected || !nativeMenu?.getClientRects().length ||
                getComputedStyle(nativeMenu).visibility === 'hidden') close();
          });
          observer.observe(document.body, { childList: true, subtree: true });
          observer.observe(nativeMenu, { attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
          signal.addEventListener('abort', () => observer.disconnect(), { once: true });
          return;
        }
      }
      if (++attempts < 30) frame = requestAnimationFrame(findAndInject);
      else close();
    };
    frame = requestAnimationFrame(findAndInject);
    signal.addEventListener('abort', () => cancelAnimationFrame(frame), { once: true });
  }

  document.addEventListener('pointerdown', (event) => {
    if (event.target instanceof Element) begin(event.target);
  }, { signal: lifecycle.signal, capture: true });
  document.addEventListener('click', (event) => {
    if (!nativeMenu && event.detail === 0 && event.target instanceof Element) begin(event.target);
    const path = event.composedPath();
    if (!path.includes(kebab!) && !path.includes(nativeMenu!) && !path.includes(submenu!)) close();
  }, { signal: lifecycle.signal, capture: true });
  document.addEventListener('keydown', (event) => {
    if (['Enter', ' '].includes(event.key) && !event.repeat && event.target instanceof Element) begin(event.target);
    if (event.key === 'Escape' && !event.composedPath().includes(submenu!) && event.target !== trigger) close();
    if (event.key !== 'ArrowDown' || !trigger || !nativeMenu) return;
    const nativeItems = Array.from(nativeMenu.querySelectorAll('[role="menuitem"], button')).filter((item) => item !== trigger);
    if (nativeItems.at(-1) === event.target) {
      event.preventDefault();
      event.stopPropagation();
      trigger.focus({ preventScroll: true });
    }
  }, { signal: lifecycle.signal, capture: true });
  document.addEventListener('scroll', (event) => {
    if (submenu && kebab && event.target instanceof Node && event.target.contains(kebab)) closeSubmenu();
  }, { signal: lifecycle.signal, capture: true });
  window.addEventListener('resize', () => close(), { signal: lifecycle.signal });

  return () => {
    close();
    lifecycle.abort();
  };
}

export function moveMenuFocus(menu: HTMLElement, event: KeyboardEvent) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('button'))
    .filter((item) => item.getClientRects().length > 0 && !item.disabled);
  if (!items.length) return;
  const current = items.indexOf(event.target as HTMLButtonElement);
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
    : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  event.preventDefault();
  event.stopPropagation();
  items[index].focus();
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

function injectMoveToProject(menuRoot: HTMLElement, actions: {
  open: (item: HTMLElement, keyboard: boolean) => void;
  leave: () => void;
  close: (restoreFocus: boolean) => void;
}): HTMLElement | null {
  const { container, deleteItem } = findMenuListContainer(menuRoot);
  if (!container || container === document.body || container === document.documentElement) {
    return null;
  }

  const item = document.createElement('button');
  item.type = 'button';
  item.setAttribute('aria-haspopup', 'menu');
  item.setAttribute('aria-expanded', 'false');
  item.style.width = '100%';
  item.style.pointerEvents = 'auto';
  item.setAttribute('role', 'menuitem');
  item.setAttribute(MENU_ITEM_ATTR, 'move-to-project');

  item.style.display = 'flex';
  item.style.alignItems = 'center';
  item.style.gap = '8px';
  item.style.textAlign = 'start';
  item.style.setProperty('height', '36px', 'important');
  item.style.setProperty('min-height', '36px', 'important');
  item.style.setProperty('max-height', '36px', 'important');
  item.style.setProperty('padding', '0 8px', 'important');
  item.style.setProperty('margin', '0', 'important');
  item.style.setProperty('box-sizing', 'border-box', 'important');
  item.style.setProperty('cursor', 'pointer', 'important');
  item.style.setProperty('border-radius', PILL_RADIUS, 'important');
  item.style.setProperty('background', 'transparent', 'important');
  item.style.setProperty('color', 'inherit', 'important');
  item.style.setProperty('border', 'none', 'important');
  item.style.setProperty('font-family', '"Google Sans Flex", "Google Sans Text", "Google Sans", sans-serif', 'important');
  item.style.setProperty('font-size', '14px', 'important');
  item.style.setProperty('font-weight', '500', 'important');
  item.style.setProperty('line-height', '20px', 'important');

  const icon = document.createElement('span');
  icon.style.setProperty('width', '20px', 'important');
  icon.style.setProperty('height', '20px', 'important');
  icon.style.setProperty('flex', '0 0 20px', 'important');
  icon.style.display = 'inline-flex';
  icon.style.alignItems = 'center';
  icon.style.justifyContent = 'center';
  icon.innerHTML = `
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 2H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
      <path d="m12 10 3 3-3 3" />
      <path d="M15 13H8" />
    </svg>
  `;

  const label = document.createElement('span');
  label.textContent = 'Move to Project';
  label.style.flex = '1';
  label.style.minWidth = '0';
  label.style.overflow = 'hidden';
  label.style.textOverflow = 'ellipsis';
  label.style.whiteSpace = 'nowrap';

  const arrow = document.createElement('span');
  arrow.style.display = 'flex';
  arrow.style.flex = '0 0 20px';
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

  item.addEventListener('mouseenter', () => actions.open(item, false));
  item.addEventListener('mouseleave', actions.leave);
  item.addEventListener('focus', () => {
    item.style.outline = '2px solid currentColor';
    item.style.outlineOffset = '-2px';
  });
  item.addEventListener('blur', () => { item.style.outline = ''; });
  item.addEventListener('click', (event) => {
    event.stopPropagation();
    actions.open(item, event.detail === 0);
  });
  item.addEventListener('keydown', (event) => {
    if (!['Enter', ' ', 'ArrowRight', 'ArrowUp', 'Escape'].includes(event.key)) return;
    if (event.key === 'ArrowUp') {
      const previous = item.previousElementSibling;
      if (!(previous instanceof HTMLElement)) return;
      previous.focus();
    } else if (event.key === 'Escape') {
      actions.close(true);
      return;
    } else {
      actions.open(item, true);
    }
    event.preventDefault();
    event.stopPropagation();
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
    return null;
  }

  return item;
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
      width: 100%;
      border: 0;
      background: transparent;
      font: inherit;
      text-align: left;
      cursor: pointer;
      color: var(--gp-fg, #141413);
      transition: background-color var(--gp-transition, .18s ease);
    }
    .gp-move-item:hover {
      background: var(--gp-bg-hover, #f5f4ed);
    }
    .gp-move-item:focus-visible {
      outline: 2px solid var(--gp-focus);
      outline-offset: -2px;
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
  `;
  shadow.appendChild(style);
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
