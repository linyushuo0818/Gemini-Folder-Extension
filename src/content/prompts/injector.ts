
const PROMPT_BTN_ATTR = 'data-gp-prompt-btn';
const PROMPT_BTN_ID = 'gp-prompt-btn';
const TOOL_HINTS = ['tools', '\u5de5\u5177'];
const UPLOAD_HINTS = [
    'upload',
    'add files',
    'add file',
    '\u9644\u4ef6',
    '\u4e0a\u4f20',
    '\u6587\u4ef6'
];
const MIC_HINTS = ['mic', 'microphone', '\u9ea6\u514b\u98ce'];
const SPEED_HINTS = ['fast', 'quick', '\u5feb\u901f'];

// Google Material Icons Round - filled (sticky_note_2)
const PROMPT_ICON_SVG = `
<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true">
  <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.89 2 1.99 2H15l6-6V5c0-1.1-.9-2-2-2ZM8 8h8c.55 0 1 .45 1 1s-.45 1-1 1H8c-.55 0-1-.45-1-1s.45-1 1-1Zm3 6H8c-.55 0-1-.45-1-1s.45-1 1-1h3c.55 0 1 .45 1 1s-.45 1-1 1Zm4 5.5V15h4.5L15 19.5Z"/>
</svg>
`;

let observer: MutationObserver | null = null;
let currentButton: HTMLElement | null = null;
let onClickHandler: (() => void) | null = null;

function log(...args: any[]) {
    // eslint-disable-next-line no-console
    console.log('[GP Prompts]', ...args);
}

function normalize(value: string | null | undefined): string {
    return (value || '').trim().toLowerCase();
}

function isVisibleElement(el: HTMLElement | null): el is HTMLElement {
    if (!el) return false;
    if (!document.body.contains(el)) return false;
    if (el.hasAttribute(PROMPT_BTN_ATTR)) return false;
    if (el.closest('#gp-prompt-picker-root')) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.pointerEvents === 'none') return false;
    const rect = el.getBoundingClientRect();
    return rect.width >= 18 && rect.height >= 18;
}

function elementLabel(el: Element): string {
    return normalize(
        (el.getAttribute('aria-label') || '') +
        ' ' +
        (el.getAttribute('title') || '') +
        ' ' +
        ((el.textContent || '').replace(/\s+/g, ' '))
    );
}

function containsAnyHint(text: string, hints: string[]): boolean {
    return hints.some((hint) => text.includes(normalize(hint)));
}

function elementVisibleText(el: Element): string {
    return normalize((el.textContent || '').replace(/\s+/g, ' '));
}

function isButtonLikeElement(el: HTMLElement): boolean {
    return el.tagName.toLowerCase() === 'button' || el.getAttribute('role') === 'button';
}

function isOversizedAnchor(el: HTMLElement): boolean {
    const rect = el.getBoundingClientRect();
    return rect.width > 320 || rect.height > 96;
}

function hasToolHint(el: HTMLElement): boolean {
    return containsAnyHint(elementLabel(el), TOOL_HINTS);
}

function hasUploadHint(el: HTMLElement): boolean {
    return containsAnyHint(elementLabel(el), UPLOAD_HINTS);
}

function isIgnoredControl(el: HTMLElement): boolean {
    const label = elementLabel(el);
    const text = elementVisibleText(el);
    const nodeType = normalize(el.getAttribute('data-node-type'));
    const tag = normalize(el.tagName);
    if (containsAnyHint(label, MIC_HINTS) || containsAnyHint(text, MIC_HINTS)) return true;
    if (containsAnyHint(label, SPEED_HINTS) || containsAnyHint(text, SPEED_HINTS)) return true;
    if (nodeType.includes('speech_dictation_mic')) return true;
    if (tag === 'speech-dictation-mic-button') return true;
    if (el.closest('speech-dictation-mic-button')) return true;
    return false;
}

function uniqueElements(elements: HTMLElement[]): HTMLElement[] {
    const seen = new Set<HTMLElement>();
    const out: HTMLElement[] = [];
    for (const el of elements) {
        if (!seen.has(el)) {
            seen.add(el);
            out.push(el);
        }
    }
    return out;
}

function findComposer(): HTMLElement | null {
    const selectors = [
        'rich-textarea [contenteditable="true"]',
        'div[contenteditable="true"][role="textbox"]',
        'textarea'
    ];
    for (const selector of selectors) {
        const candidate = document.querySelector(selector) as HTMLElement | null;
        if (isVisibleElement(candidate)) {
            return candidate;
        }
    }
    return null;
}

function findComposerRoot(composer: HTMLElement): HTMLElement {
    return (
        composer.closest<HTMLElement>('input-area-v2, [data-node-type="input-area"], .input-area') ||
        composer.parentElement ||
        composer
    );
}

function isInSidebar(el: Element): boolean {
    return !!el.closest('nav, aside, [role="navigation"], [role="complementary"]');
}

function rectDistance(a: DOMRect, b: DOMRect): { x: number; y: number } {
    const x = a.left > b.right ? a.left - b.right : b.left > a.right ? b.left - a.right : 0;
    const y = a.top > b.bottom ? a.top - b.bottom : b.top > a.bottom ? b.top - a.bottom : 0;
    return { x, y };
}

function isNearComposer(anchor: HTMLElement, composer: HTMLElement): boolean {
    const ar = anchor.getBoundingClientRect();
    const cr = composer.getBoundingClientRect();
    const d = rectDistance(ar, cr);

    // Toolbar buttons should be visually near the composer area.
    // Keep generous bounds for layout variations but reject far-away/sidebar controls.
    return d.y <= 180 && d.x <= 520;
}

function isLikelyComposerToolbarButton(anchor: HTMLElement, composer: HTMLElement): boolean {
    const ar = anchor.getBoundingClientRect();
    const cr = composer.getBoundingClientRect();
    const centerY = ar.top + ar.height / 2;
    const withinHorizontal = ar.right >= cr.left - 40 && ar.left <= cr.right + 40;
    const withinVertical = centerY >= cr.top - 8 && centerY <= cr.bottom + 44;
    const sensibleSize = ar.width <= 320 && ar.height <= 96;
    return withinHorizontal && withinVertical && sensibleSize;
}

function collectComposerControls(composer: HTMLElement): HTMLElement[] {
    const root = findComposerRoot(composer);
    const selectors = 'button, [role="button"], [mat-icon-button], [mat-button]';
    const raw = Array.from(root.querySelectorAll<HTMLElement>(selectors));
    const normalized = raw
        .map((el) => {
            const interactive = el.closest<HTMLElement>('button, [role="button"], [mat-icon-button], [mat-button]');
            return interactive || el;
        })
        .filter(
            (el) =>
                isVisibleElement(el) &&
                !isOversizedAnchor(el) &&
                !isInSidebar(el) &&
                isNearComposer(el, composer) &&
                isLikelyComposerToolbarButton(el, composer) &&
                !isIgnoredControl(el)
        );
    return uniqueElements(normalized);
}

function findToolsAnchorByText(composer: HTMLElement): HTMLElement | undefined {
    const root = findComposerRoot(composer);
    const candidates = Array.from(root.querySelectorAll<HTMLElement>('button, [role="button"]'))
        .map((el) => el.closest<HTMLElement>('button, [role="button"]') || el)
        .filter(
            (el) =>
                isButtonLikeElement(el) &&
                isVisibleElement(el) &&
                !isOversizedAnchor(el) &&
                !isInSidebar(el) &&
                isNearComposer(el, composer) &&
                isLikelyComposerToolbarButton(el, composer) &&
                !isIgnoredControl(el)
        );
    const tools = uniqueElements(candidates).filter((el) => {
        const label = normalize(el.getAttribute('aria-label'));
        const text = elementVisibleText(el);
        const className = normalize(el.className);
        const hasExactToolSignal =
            label === 'tools' ||
            label === '\u5de5\u5177' ||
            className.includes('toolbox-drawer-button');
        const hasLooseToolSignal = text === 'tools' || text === '\u5de5\u5177' || /\btools\b/.test(text) || text.includes('\u5de5\u5177');
        return hasExactToolSignal || hasLooseToolSignal;
    });
    if (!tools.length) return undefined;

    const cr = composer.getBoundingClientRect();
    return [...tools].sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        const ay = Math.abs((ar.top + ar.height / 2) - (cr.bottom - 22));
        const by = Math.abs((br.top + br.height / 2) - (cr.bottom - 22));
        const ax = Math.abs(ar.left - cr.left);
        const bx = Math.abs(br.left - cr.left);
        const aScore = ay * 2 + ax;
        const bScore = by * 2 + bx;
        return aScore - bScore;
    })[0];
}

function getAnchorScore(anchor: HTMLElement, composer: HTMLElement): number {
    const label = elementLabel(anchor);
    const ar = anchor.getBoundingClientRect();
    const cr = composer.getBoundingClientRect();
    const centerX = ar.left + ar.width / 2;
    const composerMidX = cr.left + cr.width / 2;
    const verticalDistance = Math.abs(ar.top - (cr.bottom - 44));
    const horizontalFromLeft = Math.abs(ar.left - cr.left);

    let score = 0;
    if (containsAnyHint(label, TOOL_HINTS)) score += 300;
    if (containsAnyHint(label, UPLOAD_HINTS)) score += 180;
    if (centerX <= composerMidX) score += 140;
    else score -= 180;

    // Favor anchors near the composer action row and near the left edge.
    score += Math.max(0, 160 - verticalDistance);
    score += Math.max(0, 240 - horizontalFromLeft);
    return score;
}

function pickBestAnchor(candidates: HTMLElement[], composer: HTMLElement): HTMLElement | undefined {
    if (!candidates.length) return undefined;
    return [...candidates]
        .sort((a, b) => getAnchorScore(b, composer) - getAnchorScore(a, composer))[0];
}

function pickLeftSideFallbackAnchor(candidates: HTMLElement[], composer: HTMLElement): HTMLElement | undefined {
    if (!candidates.length) return undefined;
    const cr = composer.getBoundingClientRect();
    const midX = cr.left + cr.width / 2;
    const leftSide = candidates.filter((el) => {
        const ar = el.getBoundingClientRect();
        const centerX = ar.left + ar.width / 2;
        return centerX <= midX + 16;
    });
    const pool = leftSide.length ? leftSide : candidates;
    return [...pool].sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        const aCenterX = ar.left + ar.width / 2;
        const bCenterX = br.left + br.width / 2;
        if (leftSide.length) {
            // In left cluster, prefer the right-most one so inserted button sits near Tools area.
            return bCenterX - aCenterX;
        }
        // If no left-side candidate exists, pick the left-most overall.
        return aCenterX - bCenterX;
    })[0];
}

function findAnchorNearComposer(composer: HTMLElement): HTMLElement | undefined {
    const hintedCandidates: HTMLElement[] = [];
    const allCandidates: HTMLElement[] = [];
    let parent: HTMLElement | null = composer.parentElement;
    for (let i = 0; i < 6 && parent; i += 1) {
        const rowButtons = Array.from(parent.querySelectorAll<HTMLElement>('button, div[role="button"]'))
            .filter(
                (el) =>
                    isVisibleElement(el) &&
                    !isOversizedAnchor(el) &&
                    !isInSidebar(el) &&
                    isNearComposer(el, composer) &&
                    isLikelyComposerToolbarButton(el, composer) &&
                    !isIgnoredControl(el)
            );
        allCandidates.push(...rowButtons);
        hintedCandidates.push(...rowButtons.filter((el) => hasToolHint(el) || hasUploadHint(el)));
        parent = parent.parentElement;
    }

    const uniq = Array.from(new Set(allCandidates));
    const uniqHinted = Array.from(new Set(hintedCandidates));
    return pickBestAnchor(uniqHinted, composer) || pickLeftSideFallbackAnchor(uniq, composer);
}

function isDarkTheme(): boolean {
    const bodyClasses = document.body?.className || '';
    const htmlClasses = document.documentElement?.className || '';
    const classes = `${bodyClasses} ${htmlClasses}`;
    if (/\b(light|theme-light)\b/.test(classes)) return false;
    if (/\b(dark|theme-dark|dark-theme)\b/.test(classes)) return true;

    const sample = [document.body, document.documentElement]
        .map((node) => (node ? getComputedStyle(node).backgroundColor : ''))
        .find((c) => c && c !== 'transparent');
    if (!sample) return false;

    const rgb = sample.match(/\d+(\.\d+)?/g);
    if (!rgb || rgb.length < 3) return false;
    const [r, g, b] = rgb.slice(0, 3).map(Number);
    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return luminance < 0.45;
}

export function injectPromptButton(onClick: () => void) {
    onClickHandler = onClick;
    startObserver();
    tryInject();
}

function startObserver() {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
        // Only try inject if something relevant changed, or just throttle
        const shouldCheck = mutations.some(m => m.type === 'childList' && m.addedNodes.length > 0);
        if (shouldCheck) {
            tryInject();
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

function tryInject() {
    if (currentButton && document.body.contains(currentButton)) {
        return;
    }

    const composer = findComposer();
    if (!composer) {
        return;
    }

    const anchorButton = findToolsAnchorByText(composer);
    if (!anchorButton) {
        return;
    }

    const targetContainer = anchorButton.parentElement as HTMLElement;
    if (!targetContainer) return;

    log('Found anchor:', anchorButton, 'Container:', targetContainer);

    createAndInjectButton(targetContainer, anchorButton);
}

function createAndInjectButton(container: HTMLElement, sibling: Element) {
    const siblingEl = sibling as HTMLElement;
    const pickStyleSource = (): HTMLElement => {
        const candidates = Array.from(container.querySelectorAll<HTMLElement>('button, div[role="button"]'))
            .filter((el) => el !== siblingEl && !el.hasAttribute(PROMPT_BTN_ATTR));
        const iconClassCandidates = candidates.filter((el) => /\bicon-button\b/.test(el.className));
        const pool = iconClassCandidates.length ? iconClassCandidates : candidates;
        if (!pool.length) return siblingEl;

        const siblingRect = siblingEl.getBoundingClientRect();
        pool.sort((a, b) => {
            const aRect = a.getBoundingClientRect();
            const bRect = b.getBoundingClientRect();
            const ad = Math.abs(aRect.left - siblingRect.left);
            const bd = Math.abs(bRect.left - siblingRect.left);
            return ad - bd;
        });
        return pool[0] as HTMLElement;
    };

    const styleSource = pickStyleSource();
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = PROMPT_BTN_ID;
    btn.setAttribute(PROMPT_BTN_ATTR, 'true');
    btn.setAttribute('aria-label', 'Prompts');
    btn.setAttribute('title', 'Prompts');
    btn.className = 'gp-prompt-btn';

    // Force flex centering and standard sizing
    btn.style.setProperty('display', 'flex', 'important');
    btn.style.setProperty('align-items', 'center', 'important');
    btn.style.setProperty('justify-content', 'center', 'important');
    btn.style.setProperty('margin', '0', 'important');
    btn.style.setProperty('cursor', 'pointer', 'important');
    btn.style.setProperty('flex', '0 0 auto', 'important');
    btn.style.setProperty('padding', '0', 'important');
    btn.style.setProperty('gap', '0', 'important');

    // Copy computed styles for width/height and force circular icon button
    const computed = window.getComputedStyle(styleSource);
    const parsedHeight = Number.parseFloat(computed.height || '');
    const iconButtonSize = Number.isFinite(parsedHeight) && parsedHeight > 0
        ? Math.max(36, Math.min(44, Math.round(parsedHeight)))
        : 40;
    const width = `${iconButtonSize}px`;
    const height = `${iconButtonSize}px`;

    btn.style.setProperty('width', width, 'important');
    btn.style.setProperty('height', height, 'important');
    btn.style.setProperty('min-width', width, 'important');
    btn.style.setProperty('min-height', height, 'important');
    btn.style.setProperty('max-width', width, 'important');
    btn.style.setProperty('max-height', height, 'important');
    btn.style.setProperty('border-radius', '50%', 'important');
    btn.style.setProperty('border', 'none', 'important');
    btn.style.setProperty('background-color', 'transparent', 'important');
    btn.style.setProperty('transition', 'background-color 140ms ease', 'important');
    btn.style.setProperty('outline', 'none', 'important');

    // Create our icon
    const iconSpan = document.createElement('span');
    iconSpan.style.display = 'flex';
    iconSpan.style.alignItems = 'center';
    iconSpan.style.justifyContent = 'center';
    iconSpan.style.width = '20px';
    iconSpan.style.height = '20px';
    iconSpan.style.flex = '0 0 20px';

    // Check if source had a specific icon class we might want to mimic (size-wise)
    // but honestly, we forced the button to 40x40 flex centered, so just inserting our SVG/Icon is safest.

    // Always use SVG to avoid ligature text leaking (e.g. "library_books").
    iconSpan.innerHTML = PROMPT_ICON_SVG.trim();
    const svg = iconSpan.querySelector('svg');
    if (svg) {
        svg.setAttribute('width', '20');
        svg.setAttribute('height', '20');
    }

    btn.appendChild(iconSpan);

    btn.style.opacity = '1';

    const hoverBg = isDarkTheme() ? 'rgba(255, 255, 255, 0.12)' : 'rgba(68, 71, 70, 0.08)';
    const pressBg = isDarkTheme() ? 'rgba(255, 255, 255, 0.16)' : 'rgba(68, 71, 70, 0.14)';

    btn.addEventListener('mouseenter', () => {
        btn.style.setProperty('background-color', hoverBg, 'important');
    });
    btn.addEventListener('mouseleave', () => {
        btn.style.setProperty('background-color', 'transparent', 'important');
    });
    btn.addEventListener('mousedown', () => {
        btn.style.setProperty('background-color', pressBg, 'important');
    });
    btn.addEventListener('mouseup', () => {
        btn.style.setProperty('background-color', hoverBg, 'important');
    });

    // Events
    btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClickHandler?.();
    };

    // Inject
    sibling.insertAdjacentElement('afterend', btn);
    if (!container.contains(btn)) {
        container.appendChild(btn);
    }
    currentButton = btn;
    log('Injected button');
}

