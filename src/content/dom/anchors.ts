const PROJECTS_HOST_ID = 'gemini-projects-host';
const OVERLAY_HOST_ID = 'gemini-projects-overlay';
const GEMS_SECTION_LABELS_EN = ['Gem', 'Gems'];
const CHATS_SECTION_LABELS_EN = ['Chat', 'Chats'];
const GEMS_SECTION_LABELS_ZH = ['\u5b9d\u77f3', '\u6211\u7684 Gem', '\u6211\u7684 Gems'];
const CHATS_SECTION_LABELS_ZH = ['\u804a\u5929', '\u804a\u5929\u8bb0\u5f55', '\u5bf9\u8bdd'];

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

export function findSidebarRoot(): HTMLElement | null {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>('nav, aside, [role="navigation"], [role="complementary"]')
  );
  const labels = getSectionLabelGroups();
  const gemLabels = mergeLabels(labels.gemsPrimary, labels.gemsFallback);
  const chatLabels = mergeLabels(labels.chatsPrimary, labels.chatsFallback);

  for (const candidate of candidates) {
    const text = candidate.textContent || '';
    if (includesAnyLabel(text, gemLabels) && includesAnyLabel(text, chatLabels)) {
      return candidate;
    }
  }

  return null;
}

function findSectionByTexts(root: HTMLElement, labels: string[]): HTMLElement | null {
  const targets = labels.map((label) => normalizeText(label));
  const elements = root.querySelectorAll<HTMLElement>('div, span, h2, h3, h4, button, p');
  for (const element of elements) {
    const normalized = normalizeText(element.textContent);
    if (targets.includes(normalized)) {
      return element;
    }
  }
  return null;
}

export function findGemsSection(root: HTMLElement): HTMLElement | null {
  const labels = getSectionLabelGroups();
  return findSectionByTexts(root, labels.gemsPrimary) || findSectionByTexts(root, labels.gemsFallback);
}

export function findChatsSection(root: HTMLElement): HTMLElement | null {
  const labels = getSectionLabelGroups();
  return findSectionByTexts(root, labels.chatsPrimary) || findSectionByTexts(root, labels.chatsFallback);
}

export function findChatsListContainer(chatsHeader: HTMLElement | null): HTMLElement | null {
  if (!chatsHeader) {
    return null;
  }
  let sibling = chatsHeader.nextElementSibling as HTMLElement | null;
  while (sibling) {
    if (sibling.querySelector('a[href]')) {
      return sibling;
    }
    sibling = sibling.nextElementSibling as HTMLElement | null;
  }
  return chatsHeader.parentElement;
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
  const insertBefore = chatsSection ?? null;
  const parent = chatsSection?.parentElement || root;
  if (!host) {
    host = document.createElement('div');
    host.id = PROJECTS_HOST_ID;
    host.style.all = 'initial';
    parent.insertBefore(host, insertBefore);
  } else if (host.parentElement !== parent || (insertBefore && host.nextElementSibling !== insertBefore)) {
    parent.insertBefore(host, insertBefore);
  }
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  if (!shadow.innerHTML) {
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .gp-panel { font-family: inherit; }
      </style>
      <div class="gp-panel" id="gp-panel-root"></div>
    `;
  }

  const overlay = ensureOverlayHost();
  return { host, shadow, overlayShadow: overlay.shadow };
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

export function getProjectsHostId(): string {
  return PROJECTS_HOST_ID;
}

