
export function insertPrompt(text: string): boolean {
    const composer = findComposer();
    if (!composer) {
        // eslint-disable-next-line no-console
        console.error('[Gemini Projects] No composer found');
        return false;
    }

    focusComposer(composer);

    const success = document.execCommand('insertText', false, text);
    if (!success) {
        insertTextAtCursor(text);
    }

    composer.dispatchEvent(new Event('input', { bubbles: true }));
    composer.dispatchEvent(new Event('change', { bubbles: true }));
    handlePlaceholder(composer);
    return true;
}

function focusComposer(composer: HTMLElement) {
    composer.focus();
    if (!composer.isContentEditable) return;
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(composer);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
}

function findComposer(): HTMLElement | null {
    const active = document.activeElement as HTMLElement | null;
    if (isUsableComposer(active)) {
        return active;
    }

    const selectors = [
        'rich-textarea [contenteditable="true"]',
        'div[contenteditable="true"][role="textbox"]',
        'div.ql-editor[contenteditable="true"]',
        'textarea[aria-label*="Message"]',
        'textarea[placeholder*="message"]',
        'textarea[placeholder*="Ask"]'
    ];

    for (const selector of selectors) {
        const candidate = document.querySelector(selector) as HTMLElement | null;
        if (isUsableComposer(candidate)) {
            return candidate;
        }
    }

    const candidates = Array.from(document.querySelectorAll<HTMLElement>('textarea, [contenteditable="true"]'));
    const visible = candidates.filter((el) => isUsableComposer(el));
    if (!visible.length) return null;

    visible.sort((a, b) => {
        const ar = a.getBoundingClientRect();
        const br = b.getBoundingClientRect();
        return br.bottom - ar.bottom;
    });

    return visible[0] || null;
}

function isUsableComposer(el: HTMLElement | null): boolean {
    if (!el) return false;
    if (el.closest('#gp-prompt-picker-root')) return false;
    const isEditable = el.isContentEditable || el.tagName === 'TEXTAREA';
    if (!isEditable) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 20) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return true;
}

function insertTextAtCursor(text: string) {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const node = document.createTextNode(text);
        range.insertNode(node);

        // Move cursor to end
        range.setStartAfter(node);
        range.setEndAfter(node);
        sel.removeAllRanges();
        sel.addRange(range);
    }
}

function handlePlaceholder(composer: HTMLElement) {
    // Scan text content for {{...}}
    // This is a naive implementation that works if the placeholder is in a single text node.
    // Enhanced version would traverse walker.

    const text = composer.innerText;
    const match = /\{\{(.*?)\}\}/.exec(text);
    if (match) {
        // Find the text node containing this
        // Simplification: just find the first text node with this string
        const walker = document.createTreeWalker(composer, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            const val = node.nodeValue || '';
            const idx = val.indexOf(match[0]);
            if (idx !== -1) {
                // Select it
                const range = document.createRange();
                range.setStart(node, idx);
                range.setEnd(node, idx + match[0].length);
                const sel = window.getSelection();
                sel?.removeAllRanges();
                sel?.addRange(range);
                break;
            }
        }
    }
}
