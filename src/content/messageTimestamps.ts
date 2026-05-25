type MessagePlatform = 'gemini' | 'chatgpt';

const MESSAGE_TIME_STYLE_ID = 'gp-message-time-style';
const MESSAGE_TIME_CLASS = 'gp-message-time';
const MESSAGE_TIME_ATTR = 'data-gp-time-processed';
const MESSAGE_TIME_ATTR_CANDIDATES = ['datetime', 'data-timestamp', 'data-time', 'timestamp'];

const initializedPlatforms = new Set<MessagePlatform>();

const GEMINI_USER_MESSAGE_SELECTORS = [
  'user-query',
  '[data-message-author-role="user"]',
  '[data-test-id*="user-query" i]',
  '[data-testid*="user-query" i]',
  '[data-test-id*="user-message" i]',
  '[data-testid*="user-message" i]',
  '[class*="user-query"]',
  '[class*="user-message"]'
];

const CHATGPT_USER_MESSAGE_SELECTOR = '[data-message-author-role="user"]';

export function initMessageTimestamps(platform: MessagePlatform) {
  if (initializedPlatforms.has(platform)) {
    return;
  }
  initializedPlatforms.add(platform);

  ensureMessageTimeStyle();

  const process = () => renderMessageTimestamps(platform);
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList' || mutation.type === 'attributes') {
        process();
        return;
      }
    }
  });

  const root = document.querySelector('main') || document.body;
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: MESSAGE_TIME_ATTR_CANDIDATES
  });
  process();
}

function renderMessageTimestamps(platform: MessagePlatform) {
  const candidates = collectUserMessageNodes(platform);
  candidates.forEach((messageNode) => {
    if (!isValidUserMessageNode(messageNode)) {
      return;
    }

    const extracted = extractMessageTime(messageNode);
    const formatted = extracted ? formatMessageTime(extracted) : null;
    const existingLabel = messageNode.querySelector<HTMLElement>(`.${MESSAGE_TIME_CLASS}`);

    if (!formatted) {
      existingLabel?.remove();
      messageNode.removeAttribute(MESSAGE_TIME_ATTR);
      return;
    }

    if (messageNode.getAttribute(MESSAGE_TIME_ATTR) === 'true' && existingLabel?.textContent === formatted) {
      return;
    }

    const anchor = findMessageContentAnchor(messageNode);
    const label = existingLabel || document.createElement('div');
    label.className = MESSAGE_TIME_CLASS;
    label.textContent = formatted;

    if (!existingLabel && anchor && anchor !== messageNode && anchor.parentElement && messageNode.contains(anchor)) {
      anchor.insertAdjacentElement('afterend', label);
    } else if (!existingLabel) {
      messageNode.appendChild(label);
    }

    messageNode.setAttribute(MESSAGE_TIME_ATTR, 'true');
  });
}

function collectUserMessageNodes(platform: MessagePlatform): HTMLElement[] {
  if (platform === 'chatgpt') {
    return Array.from(document.querySelectorAll<HTMLElement>(CHATGPT_USER_MESSAGE_SELECTOR));
  }

  const nodes = new Set<HTMLElement>();
  GEMINI_USER_MESSAGE_SELECTORS.forEach((selector) => {
    document.querySelectorAll<HTMLElement>(selector).forEach((node) => {
      nodes.add(node);
    });
  });
  return Array.from(nodes);
}

function isValidUserMessageNode(node: HTMLElement): boolean {
  if (!node.isConnected) {
    return false;
  }
  if (node.closest('#gemini-projects-host, #gemini-projects-overlay, #gp-prompt-picker-root')) {
    return false;
  }
  if (!node.closest('main, [role="main"]')) {
    return false;
  }

  const text = (node.textContent || '').trim();
  if (text.length < 2) {
    return false;
  }
  return true;
}

function findMessageContentAnchor(messageNode: HTMLElement): HTMLElement | null {
  const direct = messageNode.querySelector<HTMLElement>(
    '.whitespace-pre-wrap, .markdown, [class*="query-text"], [class*="message-content"], [data-test-id*="content" i], [data-testid*="content" i]'
  );
  if (direct && (direct.textContent || '').trim()) {
    return direct;
  }

  const leafTextNodes = Array.from(messageNode.querySelectorAll<HTMLElement>('p, div, span')).filter((node) => {
    const text = (node.textContent || '').trim();
    return text.length > 0 && node.children.length === 0;
  });
  if (leafTextNodes.length) {
    return leafTextNodes[leafTextNodes.length - 1];
  }

  return null;
}

function extractMessageTime(messageNode: HTMLElement): Date | null {
  const timeElement = messageNode.querySelector<HTMLTimeElement>('time[datetime], time');
  if (timeElement) {
    const datetime = timeElement.getAttribute('datetime') || timeElement.textContent || '';
    const parsed = Date.parse(datetime);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed);
    }
  }

  const attrCandidates = ['data-timestamp', 'data-time', 'timestamp'];
  for (const attr of attrCandidates) {
    const raw = messageNode.getAttribute(attr);
    if (!raw) continue;
    const numeric = Number(raw);
    if (!Number.isNaN(numeric) && numeric > 0) {
      return new Date(numeric < 1e12 ? numeric * 1000 : numeric);
    }
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed);
    }
  }

  return null;
}

function formatMessageTime(time: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit'
  }).format(time);
}

function ensureMessageTimeStyle() {
  if (document.getElementById(MESSAGE_TIME_STYLE_ID)) {
    return;
  }

  const style = document.createElement('style');
  style.id = MESSAGE_TIME_STYLE_ID;
  style.textContent = `
    .${MESSAGE_TIME_CLASS} {
      margin-top: 6px;
      font-size: 12px;
      line-height: 16px;
      color: rgba(91, 89, 84, 0.88);
      opacity: 0.9;
      letter-spacing: 0.01em;
      font-family: inherit;
    }

    @media (prefers-color-scheme: dark) {
      .${MESSAGE_TIME_CLASS} {
        color: rgba(237, 233, 224, 0.78);
      }
    }
  `;
  document.head.appendChild(style);
}
