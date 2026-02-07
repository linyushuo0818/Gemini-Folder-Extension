
const PROMPT_BTN_ATTR = 'data-gp-prompt-btn';
const PROMPT_BTN_ID = 'gp-prompt-btn';

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

    // Strategy 1: Find "Tools" button (High confidence)
    // Screenshot shows a "Tools" button with text "Tools" or icon.
    // We look for button with aria-label="Tools" or textContent "Tools"
    const allButtons = Array.from(document.querySelectorAll('button, div[role="button"]'));

    let anchorButton = allButtons.find(b => {
        const label = b.getAttribute('aria-label') || '';
        const text = b.textContent?.trim() || '';
        return label.includes('Tools') || text === 'Tools';
    });

    // Strategy 2: Find "Upload image" (High confidence)
    if (!anchorButton) {
        anchorButton = allButtons.find(b => {
            const label = b.getAttribute('aria-label') || '';
            return label.includes('Upload') || label.includes('Add files');
        });
    }

    // Strategy 3: Find the input area and look for siblings
    if (!anchorButton) {
        const composer = document.querySelector('div[contenteditable="true"][role="textbox"]');
        if (composer) {
            // Traverse up to find the action bar row
            // Usually the composer is in a container, and the tools are in a sibling container
            let parent = composer.parentElement;
            for (let i = 0; i < 4; i++) { // Go up a few levels
                if (!parent) break;
                const potentialButtons = parent.querySelectorAll('button, div[role="button"]');
                if (potentialButtons.length > 0) {
                    // Found a parent with buttons, pick the last one as anchor?
                    // Or pick the one that looks like a tool
                    // This is risky.
                }
                parent = parent.parentElement;
            }
        }
    }

    if (!anchorButton) {
        // log('No anchor button found (Tools/Upload)');
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
    const btn = (styleSource.cloneNode(true) as HTMLElement);
    // const originalBtnId = btn.id; // Unused
    btn.id = PROMPT_BTN_ID;
    btn.setAttribute(PROMPT_BTN_ATTR, 'true');
    btn.setAttribute('aria-label', 'Prompts');
    btn.setAttribute('title', 'Prompts');

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

    // Remove attributes copied from source that can conflict with host app logic.
    ['id', 'jslog', 'aria-describedby', 'aria-expanded', 'aria-haspopup', 'aria-pressed', 'data-tooltip-id'].forEach((attr) => {
        if (btn.hasAttribute(attr) && attr !== 'id') btn.removeAttribute(attr);
    });

    // CRITICAL: Clear all existing content (text nodes, icons, ripples)
    // User wants "Only one icon", so we must remove the "Tools" text if present.
    btn.innerHTML = '';

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
