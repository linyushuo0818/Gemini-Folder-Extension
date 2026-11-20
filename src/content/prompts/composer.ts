const COMPOSER_SELECTOR = [
  'rich-textarea [contenteditable="true"]',
  'rich-textarea textarea',
  'input-area textarea',
  'textarea[aria-label*="Message"]',
  'textarea[placeholder*="Ask"]'
].join(', ');

export function findComposer(): HTMLElement | null {
  const composers = Array.from(document.querySelectorAll<HTMLElement>(COMPOSER_SELECTOR))
    .filter((editor) => {
      const rect = editor.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(editor).visibility !== 'hidden';
    });
  return composers.find((editor) => editor.contains(document.activeElement)) ?? composers[0] ?? null;
}

export function getComposerPlainText(composer: HTMLElement): string {
  return composer instanceof HTMLTextAreaElement
    ? composer.value
    : (composer.innerText || '').replace(/[\u200B\uFEFF]/g, '');
}

export interface ComposerSession {
  composer: HTMLElement;
  url: string;
  draft: string;
  range: Range | null;
  textareaSelection: [start: number, end: number] | null;
  slash: boolean;
}

function draftOf(composer: HTMLElement): string {
  return composer instanceof HTMLTextAreaElement ? composer.value : composer.innerHTML;
}

export function captureComposer(composer: HTMLElement, slash = false): ComposerSession {
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  return {
    composer,
    url: location.href,
    draft: draftOf(composer),
    range: range && composer.contains(range.commonAncestorContainer) ? range.cloneRange() : null,
    textareaSelection: composer instanceof HTMLTextAreaElement
      ? [composer.selectionStart, composer.selectionEnd] : null,
    slash
  };
}

export function isCurrentComposer(session: ComposerSession): boolean {
  return session.url === location.href && findComposer() === session.composer;
}

export function restoreComposerFocus(session: ComposerSession): boolean {
  if (!isCurrentComposer(session)) return false;
  const { composer, textareaSelection, range } = session;
  composer.focus({ preventScroll: true });
  if (draftOf(composer) !== session.draft) return false;

  if (composer instanceof HTMLTextAreaElement && textareaSelection) {
    composer.setSelectionRange(...textareaSelection);
  } else {
    const selection = window.getSelection();
    if (!selection) return false;
    const currentRange = range && composer.contains(range.commonAncestorContainer) && range.cloneRange();
    const target = currentRange || document.createRange();
    if (!currentRange) {
      target.selectNodeContents(composer);
      target.collapse(false);
    }
    selection.removeAllRanges();
    selection.addRange(target);
  }
  return true;
}

export function insertPrompt(session: ComposerSession, text: string): boolean {
  if (!restoreComposerFocus(session)) return false;
  const { composer } = session;
  const selection = window.getSelection();
  if (session.slash && getComposerPlainText(composer).trim() === '/') {
    if (composer instanceof HTMLTextAreaElement) composer.select();
    else selection?.selectAllChildren(composer);
  }

  const start = composer instanceof HTMLTextAreaElement ? composer.selectionStart : textBeforeSelection(composer);
  if (start === null || !document.execCommand('insertText', false, text)) return false;

  const placeholder = /\{\{[^{}\r\n]+\}\}/.exec(text);
  if (placeholder) {
    if (composer instanceof HTMLTextAreaElement) {
      composer.setSelectionRange(start + placeholder.index, start + placeholder.index + placeholder[0].length);
    } else {
      // execCommand 对换行使用块节点，Range.toString() 只计入文本节点的字符。
      const insertedPrefix = text.slice(0, placeholder.index).replace(/[\r\n]/g, '');
      selectTextAt(composer, start + insertedPrefix.length, placeholder[0]);
    }
  }
  return true;
}

function textBeforeSelection(composer: HTMLElement): number | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!composer.contains(range.commonAncestorContainer)) return null;
  const prefix = document.createRange();
  prefix.selectNodeContents(composer);
  prefix.setEnd(range.startContainer, range.startOffset);
  return prefix.toString().length;
}

function selectTextAt(composer: HTMLElement, start: number, text: string) {
  const range = document.createRange();
  const walker = document.createTreeWalker(composer, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const end = offset + (node.nodeValue?.length ?? 0);
    if (!started && start < end) {
      range.setStart(node, start - offset);
      started = true;
    }
    if (started && start + text.length <= end) {
      range.setEnd(node, start + text.length - offset);
      const selection = window.getSelection();
      if (range.toString() === text && selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
      return;
    }
    offset = end;
  }
}
