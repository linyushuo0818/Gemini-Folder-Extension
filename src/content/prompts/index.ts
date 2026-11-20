import { findComposer, getComposerPlainText } from './composer';
import { injectPromptButton } from './injector';
import { PromptPicker } from './picker';

let triggersInstalled = false;

function getPickerAnchorRect(composer: HTMLElement | null): DOMRect | null {
  const btn = document.getElementById('gp-prompt-btn');
  if (btn) {
    const rect = btn.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return rect;
  }
  if (composer) {
    const rect = composer.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return rect;
  }
  return null;
}

function installPromptTriggers() {
  if (triggersInstalled) return;
  triggersInstalled = true;

  // 在空白输入框键入 "/" 时自动唤起 Prompt Library，删除回退时不误触。
  document.addEventListener('input', (event) => {
    if (event instanceof InputEvent) {
      if (event.isComposing || event.inputType.startsWith('delete')) return;
    }
    const target = event.target as HTMLElement | null;
    if (!target || target.closest('#gp-prompt-picker-root, #gemini-projects-overlay')) return;

    const composer = findComposer();
    if (!composer || (target !== composer && !composer.contains(target))) return;
    if (getComposerPlainText(composer) !== '/') return;

    const rect = getPickerAnchorRect(composer);
    if (!rect) return;
    PromptPicker.getInstance().open(rect, {
      triggeredBySlash: true,
      returnComposer: composer
    });
  }, true);

  // Alt+/ (macOS ⌥/) 全局唤起或关闭 Prompt Library，不与 Chrome/Gemini 原生快捷键冲突。
  document.addEventListener('keydown', (event) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.code !== 'Slash') return;

    const composer = findComposer();
    const rect = getPickerAnchorRect(composer);
    if (!rect) return;

    event.preventDefault();
    event.stopPropagation();
    PromptPicker.getInstance().toggle(rect, {
      triggeredBySlash: false,
      returnComposer: composer
    });
  }, true);
}

export function bootstrap() {
  injectPromptButton(() => {
    const composer = findComposer();
    const rect = getPickerAnchorRect(composer);
    if (rect) {
      PromptPicker.getInstance().toggle(rect, {
        triggeredBySlash: false,
        returnComposer: composer
      });
    }
  });
  installPromptTriggers();
}
