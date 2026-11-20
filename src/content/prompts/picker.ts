import { Prompt, promptStore } from './store';
import { focusComposer, insertPrompt } from './composer';
import { showSurface, hideSurface, setSurfaceOrigin } from '../ui/motion';
import { PANEL_TITLE_TYPOGRAPHY } from '../ui/typography';
import { SURFACE_THEME_CSS } from '../ui/surfaceTheme';
import { PANEL_GEOMETRY_CSS } from '../ui/radii';
import { observeGeminiTheme, resolveGeminiTheme } from '../ui/theme';

const PICKER_ID = 'gp-prompt-picker-root';

export interface PromptPickerOpenOptions {
  triggeredBySlash?: boolean;
  returnComposer?: HTMLElement | null;
}

const ICONS = {
  search: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>`,
  close: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
  edit: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`
};

// 兼顾中英文混排的粗略 token 估算（中日韩字符约 1 token，其余字符约 0.25 token）。
function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjkCount = 0;
  let otherCount = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const isCjk =
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef);
    if (isCjk) cjkCount += 1;
    else otherCount += 1;
  }
  return Math.ceil(cjkCount + otherCount / 4);
}

export class PromptPicker {
  private static instance: PromptPicker;
  private shadow: ShadowRoot;
  private host: HTMLElement;
  private isOpen = false;
  private searchQuery = '';
  private triggerRect: DOMRect | null = null;
  private selectedPromptId: string | null = null;
  private visiblePromptIds: string[] = [];
  private lastVisibleCount = 0;
  private modalDeleteConfirm = false;
  private modalDeleteTimer: number | null = null;
  private editingPrompt: Prompt | null = null;
  private triggeredBySlash = false;
  private returnComposer: HTMLElement | null = null;

  private constructor() {
    this.host = document.createElement('div');
    this.host.id = PICKER_ID;
    this.host.style.position = 'fixed';
    this.host.style.zIndex = '2147483647';
    this.host.style.display = 'none';
    this.host.style.pointerEvents = 'none';
    document.body.appendChild(this.host);

    this.shadow = this.host.attachShadow({ mode: 'open' });
    this.render();
    observeGeminiTheme((theme) => {
      this.host.dataset.gpTheme = theme;
    });

    promptStore.subscribe(() => this.updateList());

    // 全局外部点击关闭
    document.addEventListener('mousedown', (e) => {
      if (!this.isOpen) return;
      const path = e.composedPath();
      const inHost = path.includes(this.host);
      if (!inHost && !(e.target as HTMLElement).closest('[data-gp-prompt-btn]')) {
        const modal = this.shadow.querySelector('.modal-overlay') as HTMLElement | null;
        if (modal && modal.dataset.gpMotionState === 'open') return;
        this.close();
      }
    }, true);

    document.addEventListener('keydown', (e) => {
      if (!this.isOpen) return;
      const modal = this.shadow.querySelector('.modal-overlay') as HTMLElement | null;
      const modalOpen = !!modal && modal.dataset.gpMotionState === 'open';

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (modalOpen) {
          this.closeModal();
        } else {
          const composer = this.returnComposer;
          this.close();
          if (composer?.isConnected) {
            focusComposer(composer);
          } else {
            document.querySelector<HTMLButtonElement>('[data-gp-prompt-btn]')?.focus();
          }
        }
        return;
      }
      if (modalOpen) {
        if (e.key === 'Tab') {
          const controls = Array.from(modal!.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea'))
            .filter((el) => el.getBoundingClientRect().height > 0);
          const active = e.composedPath()[0];
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (e.shiftKey && (active === first || !controls.includes(active as HTMLElement))) {
            e.preventDefault();
            last?.focus();
          } else if (!e.shiftKey && (active === last || !controls.includes(active as HTMLElement))) {
            e.preventDefault();
            first?.focus();
          }
        }
        return;
      }
      const target = e.composedPath()[0] as HTMLElement;
      if (!target.closest('.search-input, .item-insert')) return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.moveSelection(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.moveSelection(-1);
        return;
      }
      if (e.key === 'Enter') {
        const active = e.composedPath()[0] as HTMLElement | null;
        if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT') && !active.classList.contains('search-input')) {
          return;
        }
        if (active?.closest('button')) return;
        e.preventDefault();
        this.insertSelectedPrompt(e.ctrlKey || e.metaKey);
      }
    });

    window.addEventListener('resize', () => {
      if (this.isOpen) {
        this.updatePosition();
        this.applyDynamicHeight(this.lastVisibleCount);
      }
    });
  }

  public static getInstance(): PromptPicker {
    if (!PromptPicker.instance) {
      PromptPicker.instance = new PromptPicker();
    }
    return PromptPicker.instance;
  }

  public toggle(rect: DOMRect, options?: PromptPickerOpenOptions) {
    if (this.isOpen) {
      this.close();
    } else {
      this.open(rect, options);
    }
  }

  public open(rect: DOMRect, options?: PromptPickerOpenOptions) {
    this.host.dataset.gpTheme = resolveGeminiTheme();
    this.isOpen = true;
    this.triggerRect = rect;
    this.selectedPromptId = null;
    this.visiblePromptIds = [];
    this.searchQuery = '';
    this.triggeredBySlash = options?.triggeredBySlash === true;
    this.returnComposer = options?.returnComposer ?? null;

    this.host.style.display = 'block';
    this.host.style.pointerEvents = 'auto';

    const picker = this.shadow.querySelector<HTMLElement>('.picker');
    if (picker) {
      showSurface(picker, 'menu', 'flex', () => {
        this.updateList();
        this.updatePosition();
      });
    }
    const input = this.shadow.querySelector('.search-input') as HTMLInputElement | null;
    if (input) {
      input.value = '';
      this.shadow.querySelector<HTMLButtonElement>('.search-clear')!.hidden = true;
      input.focus();
    }
  }

  public close() {
    this.isOpen = false;
    this.triggeredBySlash = false;
    this.returnComposer = null;
    this.host.style.pointerEvents = 'none';
    const picker = this.shadow.querySelector<HTMLElement>('.picker');
    if (picker) {
      hideSurface(picker, () => {
        if (!this.isOpen) this.host.style.display = 'none';
      });
    }
  }

  private updatePosition() {
    if (!this.triggerRect) return;
    const margin = 12;
    const gap = 10;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const mobile = viewportWidth <= 720;
    const picker = this.shadow.querySelector('.picker') as HTMLElement | null;

    const width = Math.min(400, viewportWidth - margin * 2);
    const height = Math.min(picker?.offsetHeight || 400, viewportHeight - margin * 2);

    if (picker) {
      picker.style.width = `${width}px`;
      picker.style.maxHeight = `${viewportHeight - margin * 2}px`;
    }

    let left = this.triggerRect.left;
    let top = this.triggerRect.top - height - gap;

    if (mobile) {
      left = margin;
      top = viewportHeight - height - 16;
    } else if (top >= margin) {
      // 优先悬浮在输入区上方并左对齐入口，不遮挡当前输入框内容。
      left = Math.max(margin, Math.min(this.triggerRect.left, viewportWidth - width - margin));
    } else {
      const rightSide = this.triggerRect.right + gap;
      const leftSide = this.triggerRect.left - width - gap;
      if (rightSide + width <= viewportWidth - margin) {
        left = rightSide;
      } else if (leftSide >= margin) {
        left = leftSide;
      } else {
        const centered = this.triggerRect.left + this.triggerRect.width / 2 - width / 2;
        left = Math.max(margin, Math.min(centered, viewportWidth - width - margin));
      }
      const preferredTop = this.triggerRect.bottom + gap;
      top = Math.max(margin, Math.min(preferredTop, viewportHeight - height - margin));
    }

    if (left + width > viewportWidth - margin) {
      left = viewportWidth - width - margin;
    }
    if (left < margin) {
      left = margin;
    }
    if (top < margin) {
      top = margin;
    }

    this.host.style.left = `${Math.round(left)}px`;
    this.host.style.top = `${Math.round(top)}px`;
    if (picker) {
      setSurfaceOrigin(picker, this.triggerRect, left, top);
    }
  }

  private applyDynamicHeight(itemCount: number) {
    const picker = this.shadow.querySelector('.picker') as HTMLElement | null;
    const list = this.shadow.getElementById('list-container') as HTMLElement | null;
    if (!picker || !list) return;

    const header = picker.querySelector('.header') as HTMLElement | null;
    const footer = picker.querySelector('.footer-action') as HTMLElement | null;
    const headerHeight = header?.offsetHeight || 74;
    const footerHeight = footer?.offsetHeight || 56;
    const visibleItems = Array.from(list.querySelectorAll<HTMLElement>('.item')).slice(0, 4);
    const listTarget = itemCount <= 0 ? 120 : visibleItems.reduce((height, item) => height + item.offsetHeight + 4, 8);
    const viewportMax = Math.max(0, Math.min(window.innerHeight - 24, 580));
    const target = Math.min(headerHeight + footerHeight + listTarget, viewportMax);
    picker.style.height = `${Math.round(target)}px`;
    picker.style.maxHeight = `${Math.round(viewportMax)}px`;
    this.updatePosition();
  }

  private getStyles(): string {
    return `
      ${SURFACE_THEME_CSS}
      :host {
        font-family: var(--gp-font-sans);
        color: var(--gp-fg);
      }
      * { box-sizing: border-box; }
      button, input, textarea { font: inherit; color: inherit; }
      button { cursor: pointer; }
      button:disabled { cursor: default; opacity: .5; }
      button:focus-visible, input:focus-visible, textarea:focus-visible {
        outline: 2px solid var(--gp-focus); outline-offset: 2px;
      }
      .picker {
        --gp-panel-inset: 24px;
        --gp-panel-action-height: 36px;
        ${PANEL_GEOMETRY_CSS}
        --gp-list-inset: var(--gp-panel-inset);
        --gp-radius-md: var(--gp-radius-control);
        width: 400px; max-height: calc(100dvh - 24px); position: relative;
        display: flex; flex-direction: column; overflow: hidden;
        background: var(--gp-surface); color: var(--gp-fg);
        border: var(--gp-panel-border) solid var(--gp-border);
        box-shadow: 0 16px 48px #00000026, 0 4px 12px #00000012;
        font-family: var(--gp-font-sans); font-size: 14px;
        --gp-motion-open: 150ms;
      }
      .header { padding: var(--gp-panel-inset) var(--gp-panel-inset) 20px; flex-shrink: 0; }
      .library-heading { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; gap: 8px; }
      .library-title, .modal-title { margin: 0; ${PANEL_TITLE_TYPOGRAPHY} }
      .library-count { font-size: 12px; color: var(--gp-fg-secondary); }
      .search-row { border: 1px solid var(--gp-control-border); border-radius: var(--gp-radius-control); background: var(--gp-surface); }
      .search-row:focus-within { border-color: var(--gp-focus); box-shadow: 0 0 0 1px var(--gp-focus); }
      .search-box { display: flex; align-items: center; height: 38px; padding: 0 12px; gap: 8px; }
      .search-icon { display: flex; color: var(--gp-fg-secondary); }
      .search-input { min-width: 0; width: 100%; flex: 1; border: 0; background: transparent; padding: 0; outline: none; font-size: 14px; }
      .search-input:focus-visible { outline: none; }
      .search-clear { display: grid; place-items: center; flex: 0 0 28px; width: 28px; height: 28px; padding: 0; border: 0; border-radius: var(--gp-radius-circle); background: transparent; color: var(--gp-fg-secondary); }
      .search-clear[hidden] { display: none; }
      .search-clear:hover { background: var(--gp-bg-hover); color: var(--gp-fg); }
      .search-clear svg { width: 14px; height: 14px; }
      .search-input::placeholder { color: var(--gp-fg-tertiary); }
      .list { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 0 var(--gp-list-inset) 8px; scrollbar-width: thin; scrollbar-color: var(--gp-border) transparent; }
      .empty-box { min-height: 100px; display: grid; place-content: center; padding: 16px; text-align: center; color: var(--gp-fg-secondary); font-size: 14px; }
      .item { position: relative; border-radius: var(--gp-radius-md); margin-bottom: 4px; border: .5px solid transparent; transition: background var(--gp-transition); }
      .item:hover, .item.selected, .item:focus-within { background: var(--gp-bg-active); }
      .list:has(.item:hover) .item.selected:not(:hover):not(:focus-within) { background: transparent; }
      .list:has(.item:hover) .item.selected:not(:hover):not(:focus-within) .item-actions { opacity: 0; pointer-events: none; }
      .item-insert { display: block; width: 100%; border: 0; background: transparent; text-align: left; padding: 16px; border-radius: var(--gp-radius-md); }
      .item-content { min-width: 0; }
      .item-head { display: flex; align-items: center; min-height: 24px; padding-right: 40px; margin-bottom: 4px; }
      .item-title { font-size: 14px; line-height: 19.6px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .item-preview { font-size: 14px; line-height: 19.6px; color: var(--gp-fg-secondary); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
      .item-actions { position: absolute; top: 12px; right: 12px; display: flex; opacity: 0; pointer-events: none; transition: opacity var(--gp-transition); }
      .item:hover .item-actions, .item.selected .item-actions, .item:focus-within .item-actions { opacity: 1; pointer-events: auto; }
      .item-action-btn { width: 32px; height: 32px; display: grid; place-items: center; padding: 0; border: .5px solid var(--gp-border); border-radius: var(--gp-radius-circle); background: var(--gp-surface-elevated); color: var(--gp-fg-secondary); box-shadow: 0 1px 2px #0000000a; transition: background var(--gp-transition), color var(--gp-transition), box-shadow var(--gp-transition); }
      .item-action-btn:hover { background: var(--gp-surface); color: var(--gp-fg); box-shadow: 0 2px 5px #00000014; }
      .item-action-btn svg { width: 16px; height: 16px; stroke-width: 1.75; }
      .footer-action { flex-shrink: 0; padding: var(--gp-panel-action-inset); border-top: .5px solid var(--gp-border); }
      .footer-buttons { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .footer-hint { font-size: 12px; line-height: 16.8px; color: var(--gp-fg-secondary); }
      .btn-orb { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 36px; padding: 0 16px; border: .5px solid var(--gp-accent); border-radius: var(--gp-radius-pill); background: var(--gp-accent); color: var(--gp-accent-fg); font-size: 14px; font-weight: 600; transition: opacity var(--gp-transition); }
      .btn-orb:hover { opacity: .85; }
      .btn-orb svg { width: 16px; height: 16px; }
      .modal-overlay { position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: center; justify-content: center; padding: 16px; background: var(--gp-backdrop); }
      .modal { --gp-panel-inset: 32px; --gp-panel-action-height: 36px; ${PANEL_GEOMETRY_CSS} width: min(560px, 100%); max-height: calc(100dvh - 32px); display: flex; flex-direction: column; overflow: hidden; background: var(--gp-surface); border: var(--gp-panel-border) solid var(--gp-border); box-shadow: var(--gp-shadow); font: 14px var(--gp-font-sans); color: var(--gp-fg); }
      .modal-header { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; gap: 16px; padding: var(--gp-panel-inset) var(--gp-panel-inset) 24px; }
      .modal-close { display: grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: var(--gp-radius-circle); background: transparent; color: var(--gp-fg-secondary); }
      .modal-close:hover { background: var(--gp-bg-hover); }
      .modal-body { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 4px var(--gp-panel-inset) 20px; display: flex; flex-direction: column; gap: 20px; }
      .modal-body > * { flex-shrink: 0; }
      .form-group { display: flex; flex-direction: column; gap: 8px; }
      .form-label { font-size: 14px; line-height: 19.6px; font-weight: 600; }
      .form-input, .form-textarea { width: 100%; border: .5px solid var(--gp-control-border); border-radius: var(--gp-radius-control); background: var(--gp-surface); color: var(--gp-fg); padding: 10px 12px; font-size: 14px; line-height: 19.6px; }
      .form-input { height: 40px; border-width: 1px; }
      .form-input:focus, .form-textarea:focus { outline: none; border-color: var(--gp-focus); box-shadow: 0 0 0 2px var(--gp-bg-hover); }
      .form-input::placeholder, .form-textarea::placeholder { color: var(--gp-fg-tertiary); }
      .textarea-shell { position: relative; }
      .form-textarea { display: block; height: clamp(120px, 28vh, 260px); resize: vertical; padding: 16px 16px 40px; }
      .textarea-token { position: absolute; right: 16px; bottom: 16px; font: 12px "JetBrains Mono", ui-monospace, monospace; color: var(--gp-fg-secondary); pointer-events: none; }
      .modal-footer { flex-shrink: 0; padding: var(--gp-panel-action-inset); border-top: .5px solid var(--gp-border); display: flex; justify-content: space-between; align-items: center; gap: 8px; }
      .modal-footer-left, .modal-footer-right { display: flex; align-items: center; gap: 8px; }
      .modal-footer-right { margin-left: auto; }
      .btn { height: 36px; padding: 0 16px; border-radius: var(--gp-radius-pill); border: .5px solid var(--gp-button-border); font-size: 14px; font-weight: 600; background: transparent; }
      .btn:hover { background: var(--gp-bg-hover); }
      .btn-save { border-color: var(--gp-accent); background: var(--gp-accent); color: var(--gp-accent-fg); }
      .btn-save:hover { background: var(--gp-accent); opacity: .85; }
      .btn-delete { color: var(--gp-danger); border-color: transparent; }
      .btn-delete.confirming { border-color: var(--gp-danger); }
      .form-status { margin: 0; padding: 0 var(--gp-panel-inset) 12px; font-size: 12px; color: var(--gp-danger); }
      .form-status:empty { display: none; }
      @media (max-width: 400px) {
        .modal { --gp-panel-inset: 24px; }
        .modal-header { padding-bottom: 20px; }
        .modal-close { flex: 0 0 32px; }
        .library-heading { flex-wrap: wrap; gap: 4px 12px; }
      }
      @media (hover: none) { .item-actions { opacity: 1; pointer-events: auto; } }
      @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
    `;
  }

  private render() {
    this.shadow.innerHTML = `
      <style>${this.getStyles()}</style>
      <div class="picker" role="dialog" aria-label="Prompt Library">
        <div class="header">
          <div class="library-heading"><h2 class="library-title">Prompt Library</h2><span class="library-count" id="library-count"></span></div>
          <div class="search-row">
            <div class="search-box">
              <span class="search-icon">${ICONS.search}</span>
              <input class="search-input" type="text" placeholder="Search prompts..." aria-label="Search prompts" />
              <button class="search-clear" type="button" aria-label="Clear search" hidden>${ICONS.close}</button>
            </div>
          </div>
        </div>
        <div class="list" id="list-container"></div>
        <div class="footer-action">
          <div class="footer-buttons">
            <span class="footer-hint">${/Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent) ? 'Type / or ⌥/' : 'Type / or Alt+/'}</span>
            <div class="primary-cluster">
              <button class="btn-orb btn-new" data-gp-press id="btn-primary-action" title="New Prompt">
                ${ICONS.plus}<span>New Prompt</span>
              </button>
            </div>
          </div>
        </div>
      </div>
      <div class="modal-overlay" id="modal-overlay" style="display:none;"></div>
    `;

    const input = this.shadow.querySelector('.search-input') as HTMLInputElement;
    const clearSearch = this.shadow.querySelector<HTMLButtonElement>('.search-clear')!;
    input?.addEventListener('input', (e) => {
      this.searchQuery = (e.target as HTMLInputElement).value.toLowerCase();
      clearSearch.hidden = !input.value;
      this.updateList();
    });
    clearSearch.addEventListener('click', () => {
      input.value = '';
      this.searchQuery = '';
      clearSearch.hidden = true;
      this.updateList();
      input.focus();
    });
    const header = this.shadow.querySelector('.header');
    header?.addEventListener('mousedown', (e) => e.stopPropagation());

    this.shadow.getElementById('btn-primary-action')?.addEventListener('click', () => {
      this.showModal();
    });
  }

  private showModal(prompt?: Prompt) {
    this.editingPrompt = prompt || null;
    this.modalDeleteConfirm = false;
    if (this.modalDeleteTimer) {
      window.clearTimeout(this.modalDeleteTimer);
      this.modalDeleteTimer = null;
    }
    const safeTitle = this.escapeHtml(prompt?.title || '');
    const safeContent = this.escapeHtml(prompt?.content || '');

    const overlay = this.shadow.getElementById('modal-overlay') as HTMLElement;
    this.shadow.querySelector('.picker')?.setAttribute('inert', '');
    overlay.innerHTML = `
      <div class="modal" data-gp-motion-surface role="dialog" aria-modal="true" aria-labelledby="prompt-editor-title" aria-label="${prompt ? 'Edit Prompt' : 'New Prompt'}">
        <div class="modal-header">
          <h2 class="modal-title" id="prompt-editor-title">${prompt ? 'Edit Prompt' : 'New Prompt'}</h2>
          <button class="modal-close" id="modal-close" aria-label="Close editor">${ICONS.close}</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label" for="prompt-title">Name</label>
            <input class="form-input" id="prompt-title" aria-label="Name" type="text" placeholder="e.g. Code Review" value="${safeTitle}" />
          </div>
          <div class="form-group content-group">
            <label class="form-label" for="prompt-content">Prompt Content</label>
            <div class="textarea-shell">
              <textarea class="form-textarea" id="prompt-content" aria-label="Prompt Content" placeholder="Enter your prompt template...">${safeContent}</textarea>
              <span class="textarea-token" id="content-token-estimate">~0 tokens</span>
            </div>
          </div>
        </div>
        <p class="form-status" id="form-status" role="alert"></p>
        <div class="modal-footer">
          <div class="modal-footer-left">
            ${prompt ? '<button class="btn btn-delete" id="modal-delete">Delete</button>' : ''}
          </div>
          <div class="modal-footer-right">
            <button class="btn btn-cancel" id="modal-cancel">Cancel</button>
            <button class="btn btn-save" data-gp-press id="modal-save">Save</button>
          </div>
        </div>
      </div>
    `;

    showSurface(overlay, 'modal', 'flex');

    const titleInput = overlay.querySelector('#prompt-title') as HTMLInputElement | null;
    const contentInput = overlay.querySelector('#prompt-content') as HTMLTextAreaElement | null;
    const tokenEstimateEl = overlay.querySelector('#content-token-estimate') as HTMLElement | null;
    const saveBtn = overlay.querySelector('#modal-save') as HTMLButtonElement | null;
    const updateContentMeta = () => {
      if (tokenEstimateEl) {
        tokenEstimateEl.textContent = `~${estimateTokens(contentInput?.value || '')} tokens`;
      }
    };
    const updateSaveEnabled = () => {
      const currentTitle = (titleInput?.value || '').trim();
      const currentContent = (contentInput?.value || '').trim();
      if (saveBtn) {
        saveBtn.disabled = !(currentTitle.length > 0 && currentContent.length > 0);
      }
    };

    titleInput?.addEventListener('input', updateSaveEnabled);
    contentInput?.addEventListener('input', () => {
      updateContentMeta();
      updateSaveEnabled();
    });
    updateContentMeta();
    updateSaveEnabled();

    overlay.querySelector('#modal-close')?.addEventListener('click', () => this.closeModal());
    overlay.querySelector('#modal-cancel')?.addEventListener('click', () => this.closeModal());
    overlay.querySelector('#modal-save')?.addEventListener('click', () => this.savePrompt());
    overlay.querySelector('#modal-delete')?.addEventListener('click', async () => {
      const deleteBtn = overlay.querySelector('#modal-delete') as HTMLButtonElement | null;
      if (!this.editingPrompt || !deleteBtn) return;

      if (!this.modalDeleteConfirm) {
        this.modalDeleteConfirm = true;
        deleteBtn.textContent = 'Confirm Delete';
        deleteBtn.classList.add('confirming');
        if (this.modalDeleteTimer) {
          window.clearTimeout(this.modalDeleteTimer);
        }
        this.modalDeleteTimer = window.setTimeout(() => {
          this.modalDeleteConfirm = false;
          this.modalDeleteTimer = null;
          deleteBtn.textContent = 'Delete';
          deleteBtn.classList.remove('confirming');
        }, 2200);
        return;
      }

      if (this.modalDeleteTimer) {
        window.clearTimeout(this.modalDeleteTimer);
        this.modalDeleteTimer = null;
      }
      const deletingId = this.editingPrompt.id;
      await promptStore.delete(deletingId);
      this.closeModal();
      this.updateList();
    });

    overlay.onclick = (e) => {
      if (e.target === overlay) this.closeModal();
    };

    setTimeout(() => {
      if (overlay.dataset.gpMotionState === 'open') titleInput?.focus();
    }, 50);
  }

  private closeModal() {
    const overlay = this.shadow.getElementById('modal-overlay') as HTMLElement;
    hideSurface(overlay, () => { overlay.innerHTML = ''; });
    this.shadow.querySelector('.picker')?.removeAttribute('inert');
    this.shadow.querySelector<HTMLButtonElement>('.item.selected .item-action-btn, .btn-new')?.focus();
    this.editingPrompt = null;
    this.modalDeleteConfirm = false;
    if (this.modalDeleteTimer) {
      window.clearTimeout(this.modalDeleteTimer);
      this.modalDeleteTimer = null;
    }
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  private async savePrompt() {
    const title = (this.shadow.getElementById('prompt-title') as HTMLInputElement)?.value.trim();
    const content = (this.shadow.getElementById('prompt-content') as HTMLTextAreaElement)?.value.trim();
    const status = this.shadow.getElementById('form-status');

    if (!title || !content) {
      if (status) status.textContent = 'Please fill in both Name and Prompt Content.';
      return;
    }

    const saveButton = this.shadow.getElementById('modal-save') as HTMLButtonElement | null;
    if (saveButton) {
      saveButton.disabled = true;
      saveButton.textContent = 'Saving…';
    }
    if (status) status.textContent = '';
    try {
      await promptStore.save({
        id: this.editingPrompt?.id,
        title,
        content
      });
      this.closeModal();
      this.updateList();
      this.shadow.querySelector<HTMLButtonElement>('.btn-new')?.focus();
    } catch {
      if (status) status.textContent = 'Could not save this prompt. Your draft is still here; please try again.';
    } finally {
      if (saveButton) {
        saveButton.disabled = false;
        saveButton.textContent = 'Save';
      }
    }
  }

  private moveSelection(step: number) {
    if (!this.visiblePromptIds.length) return;
    const currentIndex = this.selectedPromptId ? this.visiblePromptIds.indexOf(this.selectedPromptId) : -1;
    const baseIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = (baseIndex + step + this.visiblePromptIds.length) % this.visiblePromptIds.length;
    this.selectedPromptId = this.visiblePromptIds[nextIndex];

    const list = this.shadow.getElementById('list-container') as HTMLElement | null;
    if (!list) return;
    list.querySelectorAll('.item').forEach((el) => {
      const row = el as HTMLElement;
      row.classList.toggle('selected', row.dataset.id === this.selectedPromptId);
      if (row.dataset.id === this.selectedPromptId) {
        row.scrollIntoView({ block: 'nearest' });
        if (this.shadow.activeElement?.classList.contains('item-insert')) {
          row.querySelector<HTMLButtonElement>('.item-insert')?.focus();
        }
      }
    });
  }

  private insertSelectedPrompt(keepOpen: boolean) {
    if (!this.selectedPromptId) return;
    const prompt = promptStore.getAll().find((item) => item.id === this.selectedPromptId);
    if (!prompt) return;
    void this.onSelect(prompt, keepOpen);
  }

  private updateList() {
    const list = this.shadow.getElementById('list-container');
    if (!list) return;

    const allPrompts = promptStore.getAll();
    const displayPrompts = allPrompts.filter((p) =>
      p.title.toLowerCase().includes(this.searchQuery) ||
      p.content.toLowerCase().includes(this.searchQuery)
    );

    list.replaceChildren();
    this.visiblePromptIds = displayPrompts.map((prompt) => prompt.id);
    this.lastVisibleCount = displayPrompts.length;
    const count = this.shadow.getElementById('library-count');
    if (count) count.textContent = `${displayPrompts.length} ${displayPrompts.length === 1 ? 'prompt' : 'prompts'}`;

    if (displayPrompts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-box';
      empty.textContent = this.searchQuery ? 'No matching prompts' : 'Your library is empty. Add your first prompt.';
      list.appendChild(empty);
      this.selectedPromptId = null;
      this.applyDynamicHeight(0);
      return;
    }

    if (!this.selectedPromptId || !this.visiblePromptIds.includes(this.selectedPromptId)) {
      this.selectedPromptId = this.visiblePromptIds[0];
    }

    displayPrompts.forEach((prompt) => {
      const item = document.createElement('div');
      item.className = 'item library';
      if (this.selectedPromptId === prompt.id) {
        item.classList.add('selected');
      }
      item.dataset.id = prompt.id;

      const content = document.createElement('div');
      content.className = 'item-content';
      const head = document.createElement('div');
      head.className = 'item-head';
      const title = document.createElement('div');
      title.className = 'item-title';
      title.textContent = prompt.title;
      head.appendChild(title);

      const preview = document.createElement('div');
      preview.className = 'item-preview';
      preview.textContent = prompt.content.replace(/\s+/g, ' ').trim();
      content.appendChild(head);
      content.appendChild(preview);

      const insertButton = document.createElement('button');
      insertButton.type = 'button';
      insertButton.className = 'item-insert';
      insertButton.setAttribute('aria-label', `Insert ${prompt.title}`);
      insertButton.appendChild(content);
      item.appendChild(insertButton);

      const actions = document.createElement('div');
      actions.className = 'item-actions';

      const editBtn = document.createElement('button');
      editBtn.className = 'item-action-btn';
      editBtn.dataset.action = 'edit';
      editBtn.dataset.id = prompt.id;
      editBtn.title = 'Edit';
      editBtn.type = 'button';
      editBtn.innerHTML = ICONS.edit;
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.showModal(prompt);
      });

      actions.appendChild(editBtn);
      item.appendChild(actions);

      item.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('.item-actions')) return;
        this.selectedPromptId = prompt.id;
        void this.onSelect(prompt, false);
      });
      item.addEventListener('mouseenter', () => {
        if (this.selectedPromptId === prompt.id) return;
        this.selectedPromptId = prompt.id;
        this.moveSelection(0);
      });

      list.appendChild(item);
    });
    this.applyDynamicHeight(displayPrompts.length);
  }

  private insertPromptContent(text: string): boolean {
    const stripLeadingSlash = this.triggeredBySlash;
    this.triggeredBySlash = false;
    if (insertPrompt(text, { stripLeadingSlash })) return true;
    return this.insertPromptFallback(text);
  }

  private insertPromptFallback(text: string): boolean {
    const composer = document.querySelector('rich-textarea [contenteditable="true"], div[contenteditable="true"][role="textbox"], textarea') as HTMLElement | null;
    if (!composer) return false;
    composer.focus();
    const ok = document.execCommand('insertText', false, text);
    if (!ok) {
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(text));
      }
    }
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  private async onSelect(prompt: Prompt, keepOpen: boolean) {
    promptStore.trackUsage(prompt.id).catch(() => undefined);
    const inserted = this.insertPromptContent(prompt.content);
    if (!inserted) {
      return;
    }
    if (keepOpen) {
      this.searchQuery = '';
      const input = this.shadow.querySelector('.search-input') as HTMLInputElement | null;
      if (input) {
        input.value = '';
        input.focus();
      }
      this.updateList();
      return;
    }
    this.close();
  }
}
