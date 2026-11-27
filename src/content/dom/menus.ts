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
import { renderUiIcon } from '../ui/uiIcons';
import { MENU_ITEM_RADIUS } from '../ui/radii';
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

function isElementStillVisible(el: HTMLElement | null): boolean {
  return Boolean(
    el &&
      el.isConnected &&
      el.getClientRects().length > 0 &&
      getComputedStyle(el).visibility !== 'hidden'
  );
}

// Shadow DOM 子菜单位于 CDK 遮罩层之上，且 kebab 按钮在遮罩激活时未必带有 aria-expanded="true" 或支持二次点击关闭，
// 因此依次通过 CDK backdrop 点击、Escape 键盘事件与触发按钮兜底关闭原生菜单。
function dismissNativeMenu(menu: HTMLElement | null, nativeButton: HTMLElement | null): void {
  if (!menu || !isElementStillVisible(menu)) {
    if (!menu && nativeButton?.isConnected && nativeButton.getAttribute('aria-expanded') === 'true') {
      nativeButton.click();
    }
    return;
  }

  const backdrop = menu
    .closest('.cdk-overlay-container')
    ?.querySelector<HTMLElement>('.cdk-overlay-backdrop-showing, .cdk-overlay-backdrop');
  backdrop?.click();

  if (isElementStillVisible(menu)) {
    const target: EventTarget = menu.isConnected ? menu : document;
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        keyCode: 27,
        which: 27,
        bubbles: true,
        cancelable: true
      })
    );
  }

  if (
    !backdrop &&
    isElementStillVisible(menu) &&
    nativeButton?.isConnected &&
    nativeButton.getAttribute('aria-expanded') === 'true'
  ) {
    nativeButton.click();
  }
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
        const currentNativeMenu = nativeMenu;
        const nativeButton = kebab;
        dismissNativeMenu(currentNativeMenu, nativeButton);
        close(false);
        action();
      };
      menu.appendChild(button);
    }

    addAction('New Project', renderIconSvg('default'), options.onCreateProject);
    const current = options.getChatProjectId(conversationId);
    for (const project of options.getProjects()) {
      if (project.id === current) continue;
      addAction(project.name, renderIconSvg(project.icon, project.iconStyle, project.color),
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

interface NativeMenuItemMetrics {
  padStart: number;
  padEnd: number;
  iconBoxSize: number;
  iconVisualSize: number;
  gap: number;
  height: number;
  borderRadius: string;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  letterSpacing: string;
  color: string;
}

function findNativeMenuLabelInfo(item: HTMLElement): { rect: DOMRect; style: CSSStyleDeclaration } | null {
  const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!parent || parent.closest('mat-icon, gem-icon, svg')) continue;
    const raw = node.textContent || '';
    const firstNonSpace = raw.search(/\S/);
    if (firstNonSpace < 0) continue;
    const end = raw.trimEnd().length;
    const range = document.createRange();
    range.setStart(node, firstNonSpace);
    range.setEnd(node, end);
    const rect = range.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return { rect, style: getComputedStyle(parent) };
    }
  }
  return null;
}

function measureNativeMenuItemMetrics(referenceItem?: HTMLElement): NativeMenuItemMetrics {
  const defaults: NativeMenuItemMetrics = {
    padStart: 8,
    padEnd: 8,
    iconBoxSize: 20,
    iconVisualSize: 18,
    gap: 8,
    height: 36,
    borderRadius: MENU_ITEM_RADIUS,
    fontFamily: '"Google Sans Flex", "Google Sans", "Helvetica Neue", sans-serif',
    fontSize: '13px',
    fontWeight: '400',
    lineHeight: '17px',
    letterSpacing: 'normal',
    color: 'inherit'
  };
  if (!referenceItem) return defaults;

  const itemRect = referenceItem.getBoundingClientRect();
  const itemStyle = getComputedStyle(referenceItem);
  const isRtl = itemStyle.direction === 'rtl';

  const cssPadStart = parseFloat(isRtl ? itemStyle.paddingRight : itemStyle.paddingLeft);
  const cssPadEnd = parseFloat(isRtl ? itemStyle.paddingLeft : itemStyle.paddingRight);
  let padStart = Number.isFinite(cssPadStart) && cssPadStart > 0 ? Math.round(cssPadStart) : defaults.padStart;
  const padEnd = Number.isFinite(cssPadEnd) && cssPadEnd > 0 ? Math.round(cssPadEnd) : defaults.padEnd;

  const nativeIcon = referenceItem.querySelector<HTMLElement>('mat-icon, gem-icon, svg');
  const iconRect = nativeIcon?.getBoundingClientRect();
  const hasIconRect = Boolean(iconRect && iconRect.width >= 12 && iconRect.width <= 32 && itemRect.width > 0);
  const iconBoxSize = hasIconRect ? Math.round(iconRect!.width) : defaults.iconBoxSize;
  if (hasIconRect) {
    const measuredStart = Math.round(isRtl ? itemRect.right - iconRect!.right : iconRect!.left - itemRect.left);
    if (measuredStart >= 0 && measuredStart <= 32) {
      padStart = measuredStart;
    }
  }
  // Material font icons (20px box) have ~2px optical inset around the glyph; scaling our 24px-viewBox SVG by -2px matches visual weight and left edge.
  const iconVisualSize = Math.max(14, iconBoxSize - 2);

  const labelInfo = findNativeMenuLabelInfo(referenceItem);
  let gap = defaults.gap;
  if (labelInfo && hasIconRect) {
    const measuredGap = Math.round(
      isRtl ? iconRect!.left - labelInfo.rect.right : labelInfo.rect.left - iconRect!.right
    );
    if (measuredGap >= 4 && measuredGap <= 28) {
      gap = measuredGap;
    }
  } else if (labelInfo && itemRect.width > 0) {
    const labelStart = Math.round(isRtl ? itemRect.right - labelInfo.rect.right : labelInfo.rect.left - itemRect.left);
    const derivedGap = labelStart - padStart - iconBoxSize;
    if (derivedGap >= 4 && derivedGap <= 28) {
      gap = derivedGap;
    }
  }

  const textStyle = labelInfo?.style ?? itemStyle;
  const height = itemRect.height >= 28 && itemRect.height <= 56 ? Math.round(itemRect.height) : defaults.height;

  return {
    padStart,
    padEnd,
    iconBoxSize,
    iconVisualSize,
    gap,
    height,
    borderRadius: itemStyle.borderRadius && itemStyle.borderRadius !== '0px' ? itemStyle.borderRadius : defaults.borderRadius,
    fontFamily: textStyle.fontFamily || defaults.fontFamily,
    fontSize: textStyle.fontSize || defaults.fontSize,
    fontWeight: textStyle.fontWeight || defaults.fontWeight,
    lineHeight: textStyle.lineHeight && textStyle.lineHeight !== 'normal' ? textStyle.lineHeight : defaults.lineHeight,
    letterSpacing: textStyle.letterSpacing || defaults.letterSpacing,
    color: textStyle.color || defaults.color
  };
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

  const metrics = measureNativeMenuItemMetrics(deleteItem);

  const item = document.createElement('button');
  item.type = 'button';
  item.setAttribute('aria-haspopup', 'menu');
  item.setAttribute('aria-expanded', 'false');
  item.style.width = '100%';
  item.style.pointerEvents = 'auto';
  item.setAttribute('role', 'menuitem');
  item.setAttribute(MENU_ITEM_ATTR, 'move-to-project');

  item.style.setProperty('display', 'flex', 'important');
  item.style.setProperty('align-items', 'center', 'important');
  item.style.setProperty('gap', `${metrics.gap}px`, 'important');
  item.style.textAlign = 'start';
  item.style.setProperty('height', `${metrics.height}px`, 'important');
  item.style.setProperty('min-height', `${metrics.height}px`, 'important');
  item.style.setProperty('max-height', `${metrics.height}px`, 'important');
  item.style.setProperty('padding-top', '0', 'important');
  item.style.setProperty('padding-bottom', '0', 'important');
  item.style.setProperty('padding-inline-start', `${metrics.padStart}px`, 'important');
  item.style.setProperty('padding-inline-end', `${metrics.padEnd}px`, 'important');
  item.style.setProperty('margin', '0', 'important');
  item.style.setProperty('box-sizing', 'border-box', 'important');
  item.style.setProperty('cursor', 'pointer', 'important');
  item.style.setProperty('border-radius', metrics.borderRadius, 'important');
  item.style.setProperty('background', 'transparent', 'important');
  item.style.setProperty('color', metrics.color, 'important');
  item.style.setProperty('border', 'none', 'important');
  item.style.setProperty('font-family', metrics.fontFamily, 'important');
  item.style.setProperty('font-size', metrics.fontSize, 'important');
  item.style.setProperty('font-weight', metrics.fontWeight, 'important');
  item.style.setProperty('line-height', metrics.lineHeight, 'important');
  item.style.setProperty('letter-spacing', metrics.letterSpacing, 'important');

  const icon = document.createElement('span');
  icon.style.setProperty('width', `${metrics.iconBoxSize}px`, 'important');
  icon.style.setProperty('height', `${metrics.iconBoxSize}px`, 'important');
  icon.style.setProperty('flex', `0 0 ${metrics.iconBoxSize}px`, 'important');
  icon.style.display = 'inline-flex';
  icon.style.alignItems = 'center';
  icon.style.justifyContent = 'center';
  icon.innerHTML = renderUiIcon('folderPlus', metrics.iconVisualSize);

  const label = document.createElement('span');
  label.textContent = 'Move to Project';
  label.style.flex = '1';
  label.style.minWidth = '0';
  label.style.overflow = 'hidden';
  label.style.textOverflow = 'ellipsis';
  label.style.whiteSpace = 'nowrap';

  const arrow = document.createElement('span');
  arrow.style.display = 'inline-flex';
  arrow.style.flex = '0 0 16px';
  arrow.style.width = '16px';
  arrow.style.height = '16px';
  arrow.style.alignItems = 'center';
  arrow.style.justifyContent = 'center';
  arrow.style.opacity = '0.6';
  arrow.innerHTML = renderUiIcon('chevronRight', 16);

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
      padding: var(--gp-menu-inset, 6px);
      border-radius: var(--gp-radius-menu, 25px);
      background: var(--gp-surface, #ffffff);
      color: var(--gp-fg, #141413);
      border: .5px solid var(--gp-border, rgb(31 30 29 / .15));
      box-shadow: var(--gp-shadow-menu, inset 0 1px 0 rgb(255 255 255 / .72), 0 12px 32px rgb(20 20 19 / .14), 0 2px 8px rgb(20 20 19 / .06));
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
      border-radius: var(--gp-radius-menu-item, ${MENU_ITEM_RADIUS});
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
      background: var(--gp-bg-hover, #f1efe8);
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
  // 优先只匹配真实交互菜单项，避免先命中包含所有子文本的外层包裹容器 div.mat-mdc-menu-content。
  const actionItems = Array.from(menuRoot.querySelectorAll<HTMLElement>('[role="menuitem"], button'));
  const isDeleteNode = (el: HTMLElement) => {
    const text = (el.textContent || '').trim().toLowerCase();
    return text.length > 0 && text.length <= 32 && DELETE_ACTION_TOKENS.some((token) => text.includes(token));
  };
  const deleteItem =
    actionItems.find(isDeleteNode) ??
    Array.from(menuRoot.querySelectorAll<HTMLElement>('div')).find(
      (el) => !el.querySelector('[role="menuitem"], button') && isDeleteNode(el)
    );
  if (deleteItem?.parentElement && menuRoot.contains(deleteItem.parentElement)) {
    return { container: deleteItem.parentElement, deleteItem };
  }
  const innerMenu = menuRoot.querySelector<HTMLElement>('[role="menu"], [role="listbox"]');
  if (innerMenu && innerMenu !== menuRoot && isMenuRootVisible(innerMenu)) {
    return { container: innerMenu };
  }
  const firstItem = actionItems.find((item) => {
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
