type NodeSummary = {
  path: string;
  tag: string;
  role: string | null;
  ariaLabel: string | null;
  text: string;
  href: string | null;
  classes: string[];
  attrs: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
  display: string;
  visibility: string;
  position: string;
  zIndex: string;
  childElementCount: number;
};

type LinkCandidate = {
  link: NodeSummary;
  ancestors: NodeSummary[];
};

type SidebarInspectionReport = {
  version: string;
  capturedAt: string;
  url: string;
  title: string;
  viewport: { width: number; height: number; devicePixelRatio: number };
  buildMarker: string | null;
  sidebarCandidates: NodeSummary[];
  headingCandidates: NodeSummary[];
  conversationLinks: LinkCandidate[];
  projectsHost: NodeSummary | null;
  activeElement: NodeSummary | null;
};

declare global {
  interface Window {
    __gpInspectSidebar?: () => SidebarInspectionReport;
  }
}

const INSPECTOR_VERSION = '0.1.67';
const REQUEST_EVENT = 'gp-sidebar-inspection-request';
const RESPONSE_EVENT = 'gp-sidebar-inspection-response';
const MAX_TEXT = 140;
const MAX_CLASS_COUNT = 8;
const DATA_ATTR_ALLOWLIST = [
  'data-test-id',
  'data-testid',
  'data-id',
  'data-conversation-id',
  'data-node-id',
  'data-gp-role',
  'data-gp-build'
];

export function installSidebarInspector(): void {
  if (!window.__gpInspectSidebar) {
    window.__gpInspectSidebar = () => {
      const report = collectSidebarReport();
      publishReport(report);
      return report;
    };
  }

  document.addEventListener(REQUEST_EVENT, (event) => {
    const requestId = (event as CustomEvent<{ requestId?: string }>).detail?.requestId || String(Date.now());
    const report = collectSidebarReport();
    publishReport(report);
    document.dispatchEvent(
      new CustomEvent(RESPONSE_EVENT, {
        detail: {
          requestId,
          json: JSON.stringify(report)
        }
      })
    );
  });

  window.addEventListener(
    'keydown',
    (event) => {
      if (!(event.ctrlKey && event.shiftKey && event.altKey && event.key.toLowerCase() === 'g')) {
        return;
      }
      event.preventDefault();
      window.__gpInspectSidebar?.();
    },
    true
  );

  console.info(
    '[gemini-projects] DOM inspector ready: run await window.__gpInspectSidebar() or press Ctrl+Shift+Alt+G'
  );
}

function collectSidebarReport(): SidebarInspectionReport {
  const sidebarCandidates = findSidebarCandidates();
  const roots = sidebarCandidates.map((candidate) => getElementByPath(candidate.path)).filter(isHTMLElement);
  const scanRoots = roots.length ? roots : [document.body];

  return {
    version: INSPECTOR_VERSION,
    capturedAt: new Date().toISOString(),
    url: location.href,
    title: document.title,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio
    },
    buildMarker: document.documentElement.getAttribute('data-gp-build'),
    sidebarCandidates,
    headingCandidates: collectHeadingCandidates(scanRoots),
    conversationLinks: collectConversationLinks(scanRoots),
    projectsHost: summarizeElement(document.getElementById('gemini-projects-host')),
    activeElement: summarizeElement(document.activeElement)
  };
}

function findSidebarCandidates(): NodeSummary[] {
  const selectors = [
    'bard-sidenav',
    'mat-sidenav',
    'aside',
    'nav',
    '[role="navigation"]',
    '[aria-label*="Side" i]',
    '[aria-label*="Navigation" i]',
    '[aria-label*="Menu" i]'
  ];

  const candidates = new Set<Element>();
  selectors.forEach((selector) => {
    document.querySelectorAll(selector).forEach((node) => candidates.add(node));
  });

  document.querySelectorAll('a[href*="/app/"]').forEach((link) => {
    const root = findNavigationRoot(link);
    if (root) candidates.add(root);
  });

  return Array.from(candidates).map((node) => summarizeElement(node)).filter(isNodeSummary);
}

function collectHeadingCandidates(roots: HTMLElement[]): NodeSummary[] {
  const labels = ['Projects', 'Recents', 'Chats', 'Recent', 'Notebooks'];
  const matches: Element[] = [];

  roots.forEach((root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const element = walker.currentNode as Element;
      const text = normalizeText(element.textContent || '');
      if (!text) continue;
      if (labels.some((label) => text === label || text.startsWith(`${label} `))) {
        matches.push(element);
      }
    }
  });

  return uniqueElements(matches).slice(0, 60).map((node) => summarizeElement(node)).filter(isNodeSummary);
}

function collectConversationLinks(roots: HTMLElement[]): LinkCandidate[] {
  const links = uniqueElements(
    roots.flatMap((root) => Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href*="/app/"]')))
  );

  return links.slice(0, 120).map((link) => ({
    link: summarizeElement(link) as NodeSummary,
    ancestors: collectAncestors(link, 8)
  }));
}

function collectAncestors(element: Element, maxDepth: number): NodeSummary[] {
  const ancestors: NodeSummary[] = [];
  let cursor = element.parentElement;
  while (cursor && ancestors.length < maxDepth) {
    const summary = summarizeElement(cursor);
    if (summary) ancestors.push(summary);
    cursor = cursor.parentElement;
  }
  return ancestors;
}

function findNavigationRoot(start: Element): HTMLElement | null {
  let cursor = start.parentElement;
  let fallback: HTMLElement | null = null;

  while (cursor && cursor !== document.body) {
    const tag = cursor.tagName.toLowerCase();
    const role = cursor.getAttribute('role');
    const rect = cursor.getBoundingClientRect();

    if (cursor instanceof HTMLElement && rect.width > 160 && rect.width < 520) {
      fallback = cursor;
    }

    if (
      cursor instanceof HTMLElement &&
      (tag === 'bard-sidenav' ||
        tag === 'mat-sidenav' ||
        tag === 'aside' ||
        tag === 'nav' ||
        role === 'navigation')
    ) {
      return cursor;
    }

    cursor = cursor.parentElement;
  }

  return fallback;
}

function summarizeElement(element: Element | null | undefined): NodeSummary | null {
  if (!element) return null;
  const htmlElement = element as HTMLElement;
  const rect = htmlElement.getBoundingClientRect();
  const style = window.getComputedStyle(htmlElement);
  const attrs: Record<string, string> = {};

  DATA_ATTR_ALLOWLIST.forEach((name) => {
    const value = element.getAttribute(name);
    if (value) attrs[name] = value;
  });

  Array.from(element.attributes || []).forEach((attr) => {
    if (attr.name.startsWith('aria-') && attr.name !== 'aria-label' && attr.value) {
      attrs[attr.name] = attr.value.slice(0, 120);
    }
  });

  return {
    path: getElementPath(element),
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute('role'),
    ariaLabel: element.getAttribute('aria-label'),
    text: normalizeText(element.textContent || '').slice(0, MAX_TEXT),
    href: element instanceof HTMLAnchorElement ? element.href : null,
    classes: Array.from(element.classList || []).slice(0, MAX_CLASS_COUNT),
    attrs,
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    },
    display: style.display,
    visibility: style.visibility,
    position: style.position,
    zIndex: style.zIndex,
    childElementCount: element.childElementCount
  };
}

function getElementPath(element: Element): string {
  const parts: string[] = [];
  let cursor: Element | null = element;

  while (cursor && cursor !== document.documentElement) {
    const parentElement: Element | null = cursor.parentElement;
    const sameTagIndex = parentElement
      ? Array.from(parentElement.children)
          .filter((childElement: Element) => childElement.tagName === cursor!.tagName)
          .indexOf(cursor) + 1
      : 1;
    parts.unshift(`${cursor.tagName.toLowerCase()}:nth-of-type(${sameTagIndex})`);
    cursor = parentElement;
  }

  return `html > ${parts.join(' > ')}`;
}

function getElementByPath(path: string): Element | null {
  try {
    return document.querySelector(path.replace(/^html > /, ''));
  } catch {
    return null;
  }
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function uniqueElements<T extends Element>(elements: T[]): T[] {
  return Array.from(new Set(elements));
}

function isHTMLElement(value: Element | null): value is HTMLElement {
  return value instanceof HTMLElement;
}

function isNodeSummary(value: NodeSummary | null): value is NodeSummary {
  return !!value;
}

function publishReport(report: SidebarInspectionReport): void {
  const json = JSON.stringify(report, null, 2);
  const summary = {
    version: report.version,
    buildMarker: report.buildMarker,
    viewport: report.viewport,
    sidebarCandidates: report.sidebarCandidates.length,
    headingCandidates: report.headingCandidates.length,
    conversationLinks: report.conversationLinks.length,
    projectsHost: report.projectsHost,
    activeElement: report.activeElement
  };

  console.group('[gemini-projects] Sidebar DOM inspection');
  console.log(summary);
  console.info('[gemini-projects] Full inspection JSON is saved as localStorage.gp_sidebar_inspection_latest');
  console.groupEnd();

  try {
    localStorage.setItem('gp_sidebar_inspection_latest', json);
  } catch {
    // Ignore quota/private-mode errors; console output is still available.
  }

  navigator.clipboard?.writeText(json).then(
    () => console.info('[gemini-projects] Sidebar inspection copied to clipboard'),
    () => console.info('[gemini-projects] Sidebar inspection saved to localStorage and console')
  );
}
