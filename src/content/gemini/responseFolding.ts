import { storageLocalGet, storageLocalSet } from '../../shared/webext';
import { getConversationId } from '../dom/anchors';
import { PILL_RADIUS } from '../ui/radii';
import { observeGeminiTheme } from '../ui/theme';

const STYLE_ID = 'gp-response-fold-style';
const FEATURE_ENABLED_KEY = 'gp_feature_response_folding_enabled';
const FOLDS_KEY = 'gp_gemini_response_folds_v1';

const ROOT_CLASS = 'gp-rf-root';
const COLLAPSED_CLASS = 'gp-rf-collapsed';
const BUTTON_CLASS = 'gp-rf-button';
const ROOT_KEY_ATTR = 'data-gp-rf-key';
const BUTTON_BOUND_ATTR = 'data-gp-rf-bound';

const EXCLUDED_ROOT_SELECTOR = '#gemini-projects-host, #gemini-projects-overlay, #gp-overlay-layer, #gp-prompt-picker-root';
const DEFAULT_MIN_TEXT = 140;
const DEFAULT_COLLAPSED_HEIGHT = 220;
const DEFAULT_MAX_REMEMBERED = 1200;
const DEFAULT_ERROR_THRESHOLD = 3;
const PERSIST_DELAY_MS = 180;
const SCAN_THROTTLE_MS = 220;

const RESPONSE_ROOT_SELECTORS = [
  'main model-response',
  'main [data-message-author-role="assistant"]',
  'main [data-message-author-role="model"]',
  'main [data-test-id*="model-response"]',
  'main [data-testid*="model-response"]',
  'main [class*="model-response"]',
  'main [class*="assistant-response"]'
];

const RESPONSE_CONTENT_SELECTORS = [
  '.markdown',
  '[class*="markdown"]',
  '[data-test-id*="content"]',
  '[data-testid*="content"]',
  '[class*="response-content"]',
  '[class*="message-content"]',
  'article'
];

const USER_ROOT_SELECTORS = [
  'user-query',
  '[data-message-author-role="user"]',
  '[class*="user-query"]',
  '[class*="user-message"]'
];

type FoldMap = Record<string, 1>;

interface ResponseFoldingOptions {
  minTextLength?: number;
  collapsedHeight?: number;
  maxRemembered?: number;
  errorThreshold?: number;
}

interface ResponseCandidate {
  root: HTMLElement;
  content: HTMLElement;
  key: string;
}

interface RuntimeState {
  minTextLength: number;
  collapsedHeight: number;
  maxRemembered: number;
  errorThreshold: number;
  foldState: Set<string>;
  observedRoots: Set<HTMLElement>;
  contentByRoot: WeakMap<HTMLElement, HTMLElement>;
  observer: MutationObserver | null;
  stopThemeObserver: (() => void) | null;
  scanTimerId: number | null;
  persistTimerId: number | null;
  initialized: boolean;
  tripped: boolean;
  consecutiveErrors: number;
}

const runtime: RuntimeState = {
  minTextLength: DEFAULT_MIN_TEXT,
  collapsedHeight: DEFAULT_COLLAPSED_HEIGHT,
  maxRemembered: DEFAULT_MAX_REMEMBERED,
  errorThreshold: DEFAULT_ERROR_THRESHOLD,
  foldState: new Set<string>(),
  observedRoots: new Set<HTMLElement>(),
  contentByRoot: new WeakMap<HTMLElement, HTMLElement>(),
  observer: null,
  stopThemeObserver: null,
  scanTimerId: null,
  persistTimerId: null,
  initialized: false,
  tripped: false,
  consecutiveErrors: 0
};

export function initGeminiResponseFolding(options: ResponseFoldingOptions = {}): void {
  if (runtime.initialized || runtime.tripped) {
    return;
  }
  runtime.initialized = true;

  if (typeof options.minTextLength === 'number') runtime.minTextLength = options.minTextLength;
  if (typeof options.collapsedHeight === 'number') runtime.collapsedHeight = options.collapsedHeight;
  if (typeof options.maxRemembered === 'number') runtime.maxRemembered = options.maxRemembered;
  if (typeof options.errorThreshold === 'number') runtime.errorThreshold = options.errorThreshold;

  void guardedAsync('bootstrap', async () => {
    const enabled = await readFeatureEnabled();
    if (!enabled) {
      return;
    }
    ensureStyles();
    await loadFoldState();
    startObservers();
    scheduleScan(0);
  });
}

async function readFeatureEnabled(): Promise<boolean> {
  try {
    const result = await storageLocalGet<Record<string, unknown>>([FEATURE_ENABLED_KEY]);
    return result?.[FEATURE_ENABLED_KEY] !== false;
  } catch {
    return true;
  }
}

function startObservers(): void {
  if (runtime.observer) {
    return;
  }

  runtime.stopThemeObserver = observeGeminiTheme((theme) => {
    document.documentElement.dataset.gpRfTheme = theme;
  });

  runtime.observer = new MutationObserver((mutations) => {
    const relevant = mutations.some((mutation) => {
      if (mutation.target instanceof HTMLElement) {
        if (mutation.target.closest(EXCLUDED_ROOT_SELECTOR) || mutation.target.classList.contains(BUTTON_CLASS)) {
          return false;
        }
      }
      return mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0;
    });
    if (relevant) {
      scheduleScan();
    }
  });
  runtime.observer.observe(document.body, { childList: true, subtree: true });

  window.addEventListener('resize', onPassiveSignal, { passive: true });
  window.addEventListener('popstate', onPassiveSignal);
  window.addEventListener('hashchange', onPassiveSignal);
}

function onPassiveSignal(): void {
  scheduleScan();
}

function scheduleScan(delay = SCAN_THROTTLE_MS): void {
  if (runtime.tripped) {
    return;
  }
  if (runtime.scanTimerId !== null) {
    if (delay > 0) return;
    window.clearTimeout(runtime.scanTimerId);
  }

  runtime.scanTimerId = window.setTimeout(() => {
    runtime.scanTimerId = null;
    void guardedAsync('scan', async () => {
      renderResponseFolding();
      runtime.consecutiveErrors = 0;
    });
  }, delay);
}

function renderResponseFolding(): void {
  const candidates = collectCandidates();
  const seenRoots = new Set<HTMLElement>();

  for (const candidate of candidates) {
    seenRoots.add(candidate.root);
    runtime.observedRoots.add(candidate.root);
    runtime.contentByRoot.set(candidate.root, candidate.content);
    candidate.root.setAttribute(ROOT_KEY_ATTR, candidate.key);

    if (!isFoldable(candidate.content)) {
      clearRootUi(candidate.root);
      continue;
    }

    candidate.root.classList.add(ROOT_CLASS);
    const button = ensureToggleButton(candidate.root);
    const collapsed = runtime.foldState.has(candidate.key);
    applyCollapsedState(candidate.content, button, collapsed);
  }

  for (const root of Array.from(runtime.observedRoots)) {
    if (!seenRoots.has(root)) {
      clearRootUi(root);
      runtime.observedRoots.delete(root);
      runtime.contentByRoot.delete(root);
    }
  }
}

function collectCandidates(): ResponseCandidate[] {
  const main = document.querySelector<HTMLElement>('main, [role="main"]');
  if (!main || isExcluded(main)) {
    return [];
  }

  const rootSet = new Set<HTMLElement>();
  for (const selector of RESPONSE_ROOT_SELECTORS) {
    main.querySelectorAll<HTMLElement>(selector).forEach((node) => rootSet.add(node));
  }

  const candidates: ResponseCandidate[] = [];
  for (const root of rootSet) {
    // Gemini's current response DOM matches both the outer <model-response>
    // and nested content nodes whose class names also contain "model-response".
    // Keep the outermost candidate so one response receives one toggle button.
    if (Array.from(rootSet).some((other) => other !== root && other.contains(root))) {
      continue;
    }
    if (!isUsableNode(root)) {
      continue;
    }
    if (isUserContent(root)) {
      continue;
    }

    const content = pickBestContentNode(root);
    if (!content) {
      continue;
    }

    const stableKey = deriveStableResponseKey(root, content);
    if (!stableKey) {
      continue;
    }

    const conversationId = getConversationId(window.location.href) || 'gemini-home';
    candidates.push({
      root,
      content,
      key: `${conversationId}::${stableKey}`
    });
  }

  return candidates;
}

function pickBestContentNode(root: HTMLElement): HTMLElement | null {
  const candidates = new Set<HTMLElement>();
  candidates.add(root);

  for (const selector of RESPONSE_CONTENT_SELECTORS) {
    root.querySelectorAll<HTMLElement>(selector).forEach((node) => candidates.add(node));
  }

  let bestNode: HTMLElement | null = null;
  let bestScore = 0;

  for (const node of candidates) {
    if (!isUsableNode(node) || isUserContent(node)) {
      continue;
    }
    if (node.querySelector('textarea, input, [contenteditable="true"]')) {
      continue;
    }

    const text = normalizeText(node.textContent || '');
    const score = text.length;
    if (score < runtime.minTextLength) {
      continue;
    }
    if (score > bestScore) {
      bestScore = score;
      bestNode = node;
    }
  }

  return bestNode;
}

function isFoldable(content: HTMLElement): boolean {
  const textLen = normalizeText(content.textContent || '').length;
  if (textLen < runtime.minTextLength) {
    return false;
  }

  const fullHeight = content.scrollHeight;
  const visibleHeight = Math.max(content.clientHeight, Math.round(content.getBoundingClientRect().height));
  if (fullHeight <= 0 || visibleHeight <= 0) {
    return textLen > runtime.minTextLength * 2;
  }
  return fullHeight > runtime.collapsedHeight + 20 || fullHeight - visibleHeight > 20;
}

const CHEVRON_SVG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6"/></svg>';

function ensureToggleButton(root: HTMLElement): HTMLButtonElement {
  let button = root.querySelector<HTMLButtonElement>(`:scope > .${BUTTON_CLASS}`);
  if (!button) {
    button = document.createElement('button');
    button.type = 'button';
    button.className = BUTTON_CLASS;
    button.innerHTML = CHEVRON_SVG;
    root.appendChild(button);
  }

  if (!button.hasAttribute(BUTTON_BOUND_ATTR)) {
    button.setAttribute(BUTTON_BOUND_ATTR, '1');
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void guardedAsync('toggle', async () => {
        const key = root.getAttribute(ROOT_KEY_ATTR);
        const content = runtime.contentByRoot.get(root);
        if (!key || !content) {
          return;
        }

        const nextCollapsed = !content.classList.contains(COLLAPSED_CLASS);
        if (nextCollapsed) {
          rememberFoldedKey(key);
        } else {
          runtime.foldState.delete(key);
        }
        applyCollapsedState(content, button as HTMLButtonElement, nextCollapsed);
        schedulePersist();
      });
    });
  }

  return button;
}

function applyCollapsedState(content: HTMLElement, button: HTMLButtonElement, collapsed: boolean): void {
  const labels = getLabels();
  const nextLabel = collapsed ? labels.expand : labels.collapse;
  const nextExpanded = collapsed ? 'false' : 'true';
  content.classList.toggle(COLLAPSED_CLASS, collapsed);
  // 仅在状态变化时更新属性，避免无谓的 DOM 变更触发扫描。
  if (button.title !== nextLabel) button.title = nextLabel;
  if (button.getAttribute('aria-label') !== nextLabel) button.setAttribute('aria-label', nextLabel);
  if (button.getAttribute('aria-expanded') !== nextExpanded) button.setAttribute('aria-expanded', nextExpanded);
}

function clearRootUi(root: HTMLElement): void {
  root.classList.remove(ROOT_CLASS);

  const content = runtime.contentByRoot.get(root);
  if (content) {
    content.classList.remove(COLLAPSED_CLASS);
  }

  const button = root.querySelector<HTMLButtonElement>(`:scope > .${BUTTON_CLASS}`);
  if (button) {
    button.remove();
  }
}

function deriveStableResponseKey(root: HTMLElement, content: HTMLElement): string | null {
  const stableById = findStableId(root) || findStableId(content);
  if (stableById) {
    return `id:${stableById}`;
  }

  const normalized = normalizeText(content.textContent || '');
  if (normalized.length < runtime.minTextLength) {
    return null;
  }

  const head = normalized.slice(0, 320);
  const tail = normalized.slice(-320);
  return `hash:${fnv1a(`${head}|${normalized.length}|${tail}`)}`;
}

function findStableId(start: HTMLElement): string | null {
  let current: HTMLElement | null = start;
  const attrCandidates = ['data-message-id', 'data-response-id', 'data-turn-id', 'data-id', 'id'];

  for (let i = 0; i < 5 && current; i += 1) {
    for (const attr of attrCandidates) {
      const value = current.getAttribute(attr);
      if (looksStableId(value)) {
        return value as string;
      }
    }

    for (const [key, value] of Object.entries(current.dataset || {})) {
      if (!value) continue;
      const lower = key.toLowerCase();
      if ((lower.includes('message') || lower.includes('response') || lower.includes('turn')) && looksStableId(value)) {
        return value;
      }
    }

    current = current.parentElement;
  }
  return null;
}

function looksStableId(value: string | null): boolean {
  if (!value) return false;
  return value.length >= 6 && !/\s/.test(value);
}

function isUsableNode(node: HTMLElement): boolean {
  if (!node.isConnected) return false;
  if (!node.closest('main, [role="main"]')) return false;
  if (isExcluded(node)) return false;
  return true;
}

function isExcluded(node: HTMLElement): boolean {
  return !!node.closest(`${EXCLUDED_ROOT_SELECTOR}, nav, aside`);
}

function isUserContent(node: HTMLElement): boolean {
  return USER_ROOT_SELECTORS.some((selector) => !!node.closest(selector));
}

function rememberFoldedKey(key: string): void {
  if (runtime.foldState.has(key)) {
    runtime.foldState.delete(key);
  }
  runtime.foldState.add(key);

  while (runtime.foldState.size > runtime.maxRemembered) {
    const oldest = runtime.foldState.values().next().value as string | undefined;
    if (!oldest) break;
    runtime.foldState.delete(oldest);
  }
}

async function loadFoldState(): Promise<void> {
  try {
    const result = await storageLocalGet<Record<string, unknown>>(FOLDS_KEY);
    const raw = result?.[FOLDS_KEY];
    if (!raw || typeof raw !== 'object') {
      runtime.foldState = new Set<string>();
      return;
    }

    const keys = Object.keys(raw as Record<string, unknown>).filter(Boolean);
    runtime.foldState = new Set<string>(keys);

    while (runtime.foldState.size > runtime.maxRemembered) {
      const oldest = runtime.foldState.values().next().value as string | undefined;
      if (!oldest) break;
      runtime.foldState.delete(oldest);
    }
  } catch {
    runtime.foldState = new Set<string>();
  }
}

function schedulePersist(): void {
  if (runtime.persistTimerId !== null) {
    window.clearTimeout(runtime.persistTimerId);
  }
  runtime.persistTimerId = window.setTimeout(() => {
    runtime.persistTimerId = null;
    void guardedAsync('persist', async () => {
      const payload: FoldMap = {};
      runtime.foldState.forEach((key) => {
        payload[key] = 1;
      });
      await storageLocalSet({ [FOLDS_KEY]: payload });
    });
  }, PERSIST_DELAY_MS);
}

async function guardedAsync(stage: string, fn: () => Promise<void>): Promise<void> {
  if (runtime.tripped) {
    return;
  }
  try {
    await fn();
  } catch (error) {
    runtime.consecutiveErrors += 1;
    // eslint-disable-next-line no-console
    console.warn(`[gp-response-folding] ${stage} failed`, error);
    if (runtime.consecutiveErrors >= runtime.errorThreshold) {
      await tripCircuit(stage, error);
    }
  }
}

async function tripCircuit(stage: string, error: unknown): Promise<void> {
  if (runtime.tripped) {
    return;
  }

  // 熔断仅作用于当前页面会话，刷新后可自动恢复，避免偶发异常永久关闭功能。
  runtime.tripped = true;
  stopRuntime();
  removeInjectedUi();
  removeStyle();

  console.error(`[gp-response-folding] circuit tripped at ${stage}`, error);
}

function stopRuntime(): void {
  if (runtime.observer) {
    runtime.observer.disconnect();
    runtime.observer = null;
  }

  runtime.stopThemeObserver?.();
  runtime.stopThemeObserver = null;

  if (runtime.scanTimerId !== null) {
    window.clearTimeout(runtime.scanTimerId);
    runtime.scanTimerId = null;
  }

  if (runtime.persistTimerId !== null) {
    window.clearTimeout(runtime.persistTimerId);
    runtime.persistTimerId = null;
  }

  window.removeEventListener('resize', onPassiveSignal);
  window.removeEventListener('popstate', onPassiveSignal);
  window.removeEventListener('hashchange', onPassiveSignal);
}

function removeInjectedUi(): void {
  for (const root of Array.from(runtime.observedRoots)) {
    clearRootUi(root);
  }
  runtime.observedRoots.clear();
  runtime.contentByRoot = new WeakMap<HTMLElement, HTMLElement>();
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

function getLabels(): { collapse: string; expand: string } {
  const lang = (document.documentElement.lang || navigator.language || '').toLowerCase();
  if (lang.startsWith('zh')) {
    return {
      collapse: '\u6298\u53e0\u56de\u590d',
      expand: '\u5c55\u5f00\u56de\u590d'
    };
  }

  return {
    collapse: 'Collapse response',
    expand: 'Expand response'
  };
}

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) {
    return;
  }

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .${ROOT_CLASS} {
      position: relative !important;
    }

    .${COLLAPSED_CLASS} {
      max-height: ${runtime.collapsedHeight}px !important;
      overflow: hidden !important;
      mask-image: linear-gradient(to bottom, black 68%, transparent 100%);
      -webkit-mask-image: linear-gradient(to bottom, black 68%, transparent 100%);
    }

    .${BUTTON_CLASS} {
      position: absolute;
      top: 8px;
      right: 8px;
      width: 26px;
      height: 26px;
      padding: 0;
      border-radius: ${PILL_RADIUS};
      border: .5px solid rgb(31 30 29 / .18);
      background: rgb(255 255 255 / .92);
      color: #3d3d3a;
      box-shadow: inset 0 1px 0 rgb(255 255 255 / .72), 0 2px 6px rgb(20 20 19 / .08);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      opacity: .72;
      z-index: 3;
      transition: opacity .18s ease, background .18s ease, color .18s ease, box-shadow .18s ease, transform .14s ease;
    }

    .${BUTTON_CLASS} svg {
      display: block;
      transition: transform .18s cubic-bezier(0.22, 1, 0.36, 1);
    }

    .${BUTTON_CLASS}[aria-expanded="false"] svg {
      transform: rotate(180deg);
    }

    .${BUTTON_CLASS}:hover,
    .${BUTTON_CLASS}:focus-visible {
      opacity: 1;
      background: #faf9f5;
      color: #141413;
      box-shadow: inset 0 1px 0 rgb(255 255 255 / .8), 0 4px 12px rgb(20 20 19 / .14);
    }

    .${BUTTON_CLASS}:active {
      transform: scale(.94);
    }

    :root[data-gp-rf-theme="dark"] .${BUTTON_CLASS} {
      border-color: rgb(222 220 209 / .18);
      background: rgb(44 44 42 / .92);
      color: #c2c0b6;
      box-shadow: inset 0 1px 0 rgb(255 255 255 / .08), 0 2px 8px rgb(0 0 0 / .32);
    }

    :root[data-gp-rf-theme="dark"] .${BUTTON_CLASS}:hover,
    :root[data-gp-rf-theme="dark"] .${BUTTON_CLASS}:focus-visible {
      background: #373734;
      color: #faf9f5;
      box-shadow: inset 0 1px 0 rgb(255 255 255 / .1), 0 4px 14px rgb(0 0 0 / .44);
    }

    @media (prefers-reduced-motion: reduce) {
      .${BUTTON_CLASS}, .${BUTTON_CLASS} svg { transition: none; }
    }
  `;
  document.head.appendChild(style);
}

function removeStyle(): void {
  const style = document.getElementById(STYLE_ID);
  if (style) {
    style.remove();
  }
}
