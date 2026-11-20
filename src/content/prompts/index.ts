import { captureComposer, findComposer, getComposerPlainText } from './composer';
import { injectPromptButton } from './injector';
import { PromptPicker } from './picker';

let triggersInstalled = false;

function installPromptTriggers() {
  if (triggersInstalled) return;
  triggersInstalled = true;
  let slashKeyTarget: EventTarget | null = null;
  let pendingSlash: HTMLElement | null = null;
  let composing = false;

  document.addEventListener('compositionstart', () => {
    composing = true;
    slashKeyTarget = null;
  }, true);
  document.addEventListener('compositionend', () => { composing = false; }, true);

  document.addEventListener('beforeinput', (event) => {
    pendingSlash = null;
    const typedSlash = slashKeyTarget === event.target;
    slashKeyTarget = null;
    if (!typedSlash || !(event instanceof InputEvent) || composing || event.isComposing ||
        event.inputType !== 'insertText' || event.data !== '/') return;
    const composer = findComposer();
    if (composer && event.target === composer && !getComposerPlainText(composer).trim()) {
      pendingSlash = composer;
    }
  }, true);

  document.addEventListener('input', (event) => {
    const composer = pendingSlash;
    pendingSlash = null;
    if (composer && event.target === composer && event instanceof InputEvent &&
        event.inputType === 'insertText' && event.data === '/' && !event.isComposing &&
        getComposerPlainText(composer).trim() === '/') {
      PromptPicker.getInstance().open(captureComposer(composer, true), composer);
    }
  }, true);

  document.addEventListener('keyup', () => { slashKeyTarget = null; }, true);
  document.addEventListener('keydown', (event) => {
    slashKeyTarget = event.key === '/' && !event.altKey && !event.ctrlKey && !event.metaKey &&
      !event.isComposing && !composing ? event.target : null;
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.code !== 'Slash' ||
        event.isComposing || composing || event.keyCode === 229) return;
    const composer = findComposer();
    if (!composer) return;
    const target = event.composedPath()[0];
    if (target instanceof HTMLElement && target !== composer &&
        target.closest('input, textarea, [contenteditable="true"], [role="dialog"]') &&
        !target.closest('.picker[aria-label="Prompt Library"]')) return;
    const picker = PromptPicker.getInstance();
    if (picker.isEditing()) return;

    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) picker.toggle(composer, composer.contains(document.activeElement) ? composer : null);
  }, true);
}

export function bootstrap() {
  injectPromptButton(() => {
    const composer = findComposer();
    if (composer) PromptPicker.getInstance().toggle(composer, document.getElementById('gp-prompt-btn'));
  });
  installPromptTriggers();
}
