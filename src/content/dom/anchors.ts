const PROJECTS_HOST_ID = 'gemini-projects-host';
const OVERLAY_HOST_ID = 'gemini-projects-overlay';
const GEMS_SECTION_LABELS_EN = ['Gem', 'Gems'];
const CHATS_SECTION_LABELS_EN = ['Chat', 'Chats', 'Recents', 'Recent chats'];
const SIDEBAR_LANDMARK_LABELS_EN = ['New chat', 'Search chats', 'Gems', 'Notebooks', 'Recents'];
const GEMS_SECTION_LABELS_ZH = ['\u5b9d\u77f3', '\u6211\u7684 Gem', '\u6211\u7684 Gems'];
const CHATS_SECTION_LABELS_ZH = ['\u804a\u5929', '\u804a\u5929\u8bb0\u5f55', '\u5bf9\u8bdd', '\u6700\u8fd1', '\u6700\u8fd1\u804a\u5929', '\u6700\u8fd1\u5bf9\u8bdd'];
const SIDEBAR_LANDMARK_LABELS_ZH = ['\u65b0\u5bf9\u8bdd', '\u641c\u7d22\u804a\u5929', '\u641c\u7d22\u5bf9\u8bdd', '\u6211\u7684 Gem', '\u7b14\u8bb0\u672c', '\u6700\u8fd1'];

function normalizeText(value: string | null): string {
  return (value || '').trim().toLowerCase();
}

function includesAnyLabel(text: string, labels: string[]): boolean {
  const normalized = normalizeText(text);
  return labels.some((label) => normalized.includes(normalizeText(label)));
}

function isZhLanguage(lang: string): boolean {
  return normalizeText(lang).startsWith('zh');
}

function detectUiLanguage(): 'zh' | 'en' {
  const docLang = document.documentElement?.lang || '';
  if (isZhLanguage(docLang)) {
    return 'zh';
  }

  const browserLangs = [navigator.language || '', ...(navigator.languages || [])];
  if (browserLangs.some((lang) => isZhLanguage(lang))) {
    return 'zh';
  }

  return 'en';
}

function getSectionLabelGroups(): {
  gemsPrimary: string[];
  chatsPrimary: string[];
  gemsFallback: string[];
  chatsFallback: string[];
} {
  if (detectUiLanguage() === 'zh') {
    return {
      gemsPrimary: GEMS_SECTION_LABELS_ZH,
      chatsPrimary: CHATS_SECTION_LABELS_ZH,
      gemsFallback: GEMS_SECTION_LABELS_EN,
      chatsFallback: CHATS_SECTION_LABELS_EN
    };
  }
  return {
    gemsPrimary: GEMS_SECTION_LABELS_EN,
    chatsPrimary: CHATS_SECTION_LABELS_EN,
    gemsFallback: GEMS_SECTION_LABELS_ZH,
    chatsFallback: CHATS_SECTION_LABELS_ZH
  };
}

function mergeLabels(primary: string[], fallback: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const label of [...primary, ...fallback]) {
    const key = normalizeText(label);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(label);
    }
  }
  return merged;
}

function isVisibleElement(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
}

function isGeminiSidebarRoot(element: HTMLElement): boolean {
  const tag = element.tagName.toLowerCase();
  const ariaLabel = normalizeText(element.getAttribute('aria-label'));
  return tag === 'bard-sidenav' || ariaLabel === 'side navigation';
}

function hasConversationLinks(root: ParentNode): boolean {
  return Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]')).some((link) =>
    Boolean(getConversationId(link.href))
  );
}

function countConversationLinks(root: ParentNode): number {
  return Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]')).filter((link) =>
    Boolean(getConversationId(link.href))
  ).length;
}

export function findSidebarRoot(): HTMLElement | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      'bard-sidenav, nav, aside, [role="navigation"], [role="complementary"], side-nav, mat-sidenav'
    )
  ).filter(isVisibleElement);

  const explicitSidebar = candidates.find(isGeminiSidebarRoot);
  if (explicitSidebar) {
    return explicitSidebar;
  }

  const labels = getSectionLabelGroups();
  const gemLabels = mergeLabels(labels.gemsPrimary, labels.gemsFallback);
  const chatLabels = mergeLabels(labels.chatsPrimary, labels.chatsFallback);

  for (const candidate of candidates) {
    const text = candidate.textContent || '';
    if ((includesAnyLabel(text, gemLabels) && includesAnyLabel(text, chatLabels)) || hasConversationLinks(candidate)) {
      return candidate;
    }
  }

  return findSidebarByLandmarks();
}

function findSectionByTexts(root: HTMLElement, labels: string[]): HTMLElement | null {
  const targets = labels.map((label) => normalizeText(label));
  const elements = root.querySelectorAll<HTMLElement>('a, div, span, h1, h2, h3, h4, button, p');
  const visibleElements = Array.from(elements).filter(isVisibleElement);
  for (const element of visibleElements) {
    const normalized = normalizeText(element.textContent);
    if (targets.includes(normalized)) {
      return element;
    }
  }
  for (const element of visibleElements) {
    const normalized = normalizeText(element.textContent);
    if (normalized.length <= 48 && targets.some((target) => normalized.includes(target))) {
      return element;
    }
  }
  return null;
}

function findSidebarByLandmarks(): HTMLElement | null {
  const landmarkLabels = mergeLabels(SIDEBAR_LANDMARK_LABELS_EN, SIDEBAR_LANDMARK_LABELS_ZH);
  const elements = Array.from(document.body.querySelectorAll<HTMLElement>('body *')).filter((element) => {
    const rect = element.getBoundingClientRect();
    if (!isVisibleElement(element)) return false;
    if (rect.left > 80) return false;
    if (rect.width < 180 || rect.width > 520) return false;
    if (rect.height < Math.min(360, window.innerHeight * 0.45)) return false;

    const text = element.textContent || '';
    const hits = landmarkLabels.filter((label) => includesAnyLabel(text, [label])).length;
    return hits >= 3;
  });

  if (!elements.length) return null;

  return elements
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return { element, area: rect.width * rect.height };
    })
    .sort((a, b) => a.area - b.area)[0].element;
}

export function findGemsSection(root: HTMLElement): HTMLElement | null {
  const labels = getSectionLabelGroups();
  return findSectionByTexts(root, labels.gemsPrimary) || findSectionByTexts(root, labels.gemsFallback);
}

export function findChatsSection(root: HTMLElement): HTMLElement | null {
  const labels = getSectionLabelGroups();
  const byText = findSectionByTexts(root, labels.chatsPrimary) || findSectionByTexts(root, labels.chatsFallback);
  if (byText) {
    return byText;
  }

  const toggles = Array.from(root.querySelectorAll<HTMLElement>('[data-test-id="expandable-section-toggle"], button[aria-label]'));
  const chatLabels = mergeLabels(labels.chatsPrimary, labels.chatsFallback);
  for (const toggle of toggles) {
    const label = toggle.getAttribute('aria-label') || '';
    const text = toggle.textContent || '';
    if (includesAnyLabel(label, chatLabels) || includesAnyLabel(text, chatLabels)) {
      return toggle;
    }
  }

  return findFirstConversationList(root);
}

export function findChatsListContainer(chatsHeader: HTMLElement | null): HTMLElement | null {
  if (!chatsHeader) {
    return null;
  }
  if (hasConversationLinks(chatsHeader)) {
    return chatsHeader;
  }

  let sibling = chatsHeader.nextElementSibling as HTMLElement | null;
  while (sibling) {
    if (hasConversationLinks(sibling)) {
      return sibling;
    }
    sibling = sibling.nextElementSibling as HTMLElement | null;
  }

  let parent = chatsHeader.parentElement;
  for (let depth = 0; parent && depth < 5; depth += 1) {
    const children = Array.from(parent.children) as HTMLElement[];
    const headerIndex = children.indexOf(chatsHeader);
    const afterHeader = headerIndex >= 0 ? children.slice(headerIndex + 1) : children;
    const siblingList = afterHeader.find((child) => hasConversationLinks(child));
    if (siblingList) {
      return siblingList;
    }
    if (hasConversationLinks(parent) && parent !== document.body) {
      return parent;
    }
    parent = parent.parentElement;
  }

  return findFirstConversationList(findSidebarRoot() || document.body);
}

function findFirstConversationList(root: ParentNode): HTMLElement | null {
  const links = Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]')).filter((link) =>
    Boolean(getConversationId(link.href))
  );
  if (!links.length) {
    return null;
  }

  let current: HTMLElement | null = links[0].parentElement;
  while (current && current !== document.body) {
    const parent = current.parentElement;
    if (!parent) {
      break;
    }
    const currentCount = Array.from(current.querySelectorAll<HTMLAnchorElement>('a[href]')).filter((link) =>
      Boolean(getConversationId(link.href))
    ).length;
    const parentCount = Array.from(parent.querySelectorAll<HTMLAnchorElement>('a[href]')).filter((link) =>
      Boolean(getConversationId(link.href))
    ).length;
    if (parentCount !== currentCount || isGeminiSidebarRoot(parent)) {
      return current;
    }
    current = parent;
  }

  return links[0].parentElement;
}

function ensureOverlayHost(): { host: HTMLElement; shadow: ShadowRoot } {
  let host = document.getElementById(OVERLAY_HOST_ID) as HTMLElement | null;
  if (!host) {
    host = document.createElement('div');
    host.id = OVERLAY_HOST_ID;
    host.style.all = 'initial';
    document.documentElement.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .gp-overlay {
          position: fixed;
          inset: 0;
          pointer-events: none;
          z-index: 2147483646;
          font-family: inherit;
        }
        .gp-layer {
          position: absolute;
          inset: 0;
          pointer-events: none;
        }
      </style>
      <div class="gp-overlay">
        <div class="gp-layer" id="gp-overlay-layer"></div>
      </div>
    `;
  }
  const shadow = host.shadowRoot as ShadowRoot;
  return { host, shadow };
}

export function injectProjectsSection(
  root: HTMLElement,
  gemsSection: HTMLElement | null,
  chatsSection: HTMLElement | null
): { host: HTMLElement; shadow: ShadowRoot; overlayShadow: ShadowRoot } {
  let host = document.getElementById(PROJECTS_HOST_ID) as HTMLElement | null;
  const { parent, insertBefore } = getStableProjectsInsertion(root, chatsSection);
  if (!host) {
    host = document.createElement('div');
    host.id = PROJECTS_HOST_ID;
    host.style.all = 'initial';
    host.style.display = 'block';
    host.style.width = '100%';
    host.style.pointerEvents = 'auto';
    host.style.position = 'relative';
    host.style.zIndex = '1';
    parent.insertBefore(host, insertBefore);
  } else if (host.parentElement !== parent || (insertBefore && host.nextElementSibling !== insertBefore)) {
    host.style.display = 'block';
    host.style.width = '100%';
    host.style.pointerEvents = 'auto';
    host.style.position = 'relative';
    host.style.zIndex = '1';
    parent.insertBefore(host, insertBefore);
  }
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  if (!shadow.innerHTML) {
    shadow.innerHTML = `
      <style>
        :host { all: initial; display: block; width: 100%; pointer-events: auto; position: relative; isolation: isolate; }
        .gp-panel { font-family: inherit; }
      </style>
      <div class="gp-panel" id="gp-panel-root"></div>
    `;
  }

  const overlay = ensureOverlayHost();
  return { host, shadow, overlayShadow: overlay.shadow };
}

function getStableProjectsInsertion(
  root: HTMLElement,
  chatsSection: HTMLElement | null
): { parent: HTMLElement; insertBefore: Element | null } {
  if (!chatsSection || chatsSection === root) {
    return { parent: root, insertBefore: null };
  }

  let candidate: HTMLElement = chatsSection;
  for (let depth = 0; candidate.parentElement && candidate.parentElement !== root && depth < 4; depth += 1) {
    const parent = candidate.parentElement;
    const siblings = Array.from(parent.children);
    const hasConversationSibling = siblings.some((child) => child !== candidate && hasConversationLinks(child));
    const parentLooksLikeSection = siblings.length >= 2 && hasConversationSibling;
    if (parentLooksLikeSection) {
      return { parent, insertBefore: candidate };
    }
    candidate = parent;
  }

  let directChild: HTMLElement | null = chatsSection;
  while (directChild?.parentElement && directChild.parentElement !== root) {
    directChild = directChild.parentElement;
  }

  return {
    parent: directChild?.parentElement === root ? root : chatsSection.parentElement || root,
    insertBefore: directChild?.parentElement === root ? directChild : chatsSection
  };
}

function extractIdFromPath(pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean);
  const appIndex = parts.indexOf('app');
  if (appIndex >= 0 && parts.length > appIndex + 1) {
    return parts[appIndex + 1];
  }
  return null;
}

export function getConversationId(input?: string | Element | null): string | null {
  if (!input) {
    return null;
  }

  if (typeof input === 'string') {
    try {
      const url = new URL(input, window.location.origin);
      return (
        extractIdFromPath(url.pathname) ||
        url.searchParams.get('conversationId') ||
        url.searchParams.get('conversation_id') ||
        url.searchParams.get('id') ||
        url.searchParams.get('cid') ||
        (url.hash ? url.hash.replace('#', '') : null)
      );
    } catch {
      return null;
    }
  }

  const element = input as HTMLElement;
  const datasetId = element.dataset?.conversationId || element.dataset?.id;
  if (datasetId) {
    return datasetId;
  }

  if (element instanceof HTMLAnchorElement && element.href) {
    return getConversationId(element.href);
  }

  const link = element.querySelector<HTMLAnchorElement>('a[href]');
  if (link?.href) {
    return getConversationId(link.href);
  }

  return null;
}

function looksLikeId(value: string): boolean {
  return value.length >= 8 && !/\s/.test(value);
}

function pickIdFromElement(element: HTMLElement): string | null {
  const href = element.getAttribute('href') || element.getAttribute('data-href') || element.getAttribute('data-url');
  if (href) {
    const parsed = getConversationId(href);
    if (parsed) return parsed;
  }

  const dataset = element.dataset;
  if (dataset) {
    for (const [key, value] of Object.entries(dataset)) {
      if (!value) continue;
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.includes('conversation') ||
        lowerKey.includes('chat') ||
        lowerKey === 'id' ||
        lowerKey.endsWith('id')
      ) {
        if (looksLikeId(value)) {
          return value;
        }
      }
    }
  }

  const attrCandidates = ['data-conversation-id', 'data-id', 'data-chat-id', 'data-uuid'];
  for (const attr of attrCandidates) {
    const value = element.getAttribute(attr);
    if (value && looksLikeId(value)) {
      return value;
    }
  }

  return null;
}

function findConversationIdDeep(root: HTMLElement): string | null {
  const direct = pickIdFromElement(root);
  if (direct) return direct;

  const anchor = root.querySelector<HTMLAnchorElement>('a[href]');
  if (anchor?.href) {
    const parsed = getConversationId(anchor.href);
    if (parsed) return parsed;
  }

  const descendants = root.querySelectorAll<HTMLElement>('*');
  for (const child of Array.from(descendants)) {
    const candidate = pickIdFromElement(child);
    if (candidate) return candidate;
    if (child instanceof HTMLAnchorElement && child.href) {
      const parsed = getConversationId(child.href);
      if (parsed) return parsed;
    }
  }

  return null;
}

function findConversationIdByTitle(title: string): string | null {
  const trimmed = title.trim();
  if (!trimmed) return null;
  const sidebar = findSidebarRoot();
  if (!sidebar) return null;

  const links = Array.from(sidebar.querySelectorAll<HTMLAnchorElement>('a[href]'));
  for (const link of links) {
    if ((link.textContent || '').trim() === trimmed) {
      const parsed = getConversationId(link.href);
      if (parsed) return parsed;
    }
  }

  const dataNodes = Array.from(
    sidebar.querySelectorAll<HTMLElement>('[data-conversation-id], [data-id], [data-chat-id]')
  );
  for (const node of dataNodes) {
    if ((node.textContent || '').trim() === trimmed) {
      const datasetId = node.dataset?.conversationId || node.dataset?.id || node.dataset?.chatId;
      if (datasetId && looksLikeId(datasetId)) {
        return datasetId;
      }
    }
  }

  return null;
}

export function getConversationIdFromChatRow(row: Element | null): string | null {
  if (!row) return null;
  const element = row as HTMLElement;
  const datasetId = element.dataset?.conversationId || element.dataset?.id;
  if (datasetId) {
    return datasetId;
  }
  const deep = findConversationIdDeep(element);
  if (deep) {
    return deep;
  }
  const title = (element.textContent || '').trim();
  if (title) {
    return findConversationIdByTitle(title);
  }
  return null;
}

export function findChatRowElement(target: Element | null, listRoot?: HTMLElement | null): HTMLElement | null {
  if (!target) return null;

  const directListItem = target.closest('[role="listitem"], li') as HTMLElement | null;
  if (directListItem) {
    return directListItem;
  }

  const anchor = target.closest('a[href]') as HTMLAnchorElement | null;
  let current: HTMLElement | null = (anchor?.parentElement || target.closest('div') || target) as HTMLElement | null;
  const boundary = listRoot || findChatsListContainer(findChatsSection(findSidebarRoot() || document.body));

  while (current && current !== document.body) {
    if (boundary && !boundary.contains(current) && current !== boundary) {
      break;
    }

    const currentCount = countConversationLinks(current);
    if (currentCount === 1) {
      const parent = current.parentElement;
      if (!parent || parent === document.body || parent === boundary) {
        return current;
      }

      const parentCount = countConversationLinks(parent);
      if (parentCount !== 1) {
        return current;
      }

      current = parent;
      continue;
    }

    current = current.parentElement;
  }

  return (target.closest('[role="listitem"], li, div') as HTMLElement | null) || (anchor as HTMLElement | null);
}

export function getProjectsHostId(): string {
  return PROJECTS_HOST_ID;
}

