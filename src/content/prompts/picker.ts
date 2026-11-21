import { Prompt, promptStore } from './store';
import { captureComposer, ComposerSession, insertPrompt, isCurrentComposer, restoreComposerFocus } from './composer';
import { showSurface, hideSurface, setSurfaceOrigin } from '../ui/motion';
import { PANEL_TITLE_TYPOGRAPHY } from '../ui/typography';
import { SURFACE_THEME_CSS } from '../ui/surfaceTheme';
import { observeGeminiTheme, resolveGeminiTheme } from '../ui/theme';

const PICKER_ID = 'gp-prompt-picker-root';

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
  private session: ComposerSession | null = null;
  private opener: HTMLElement | null = null;
  private editorOpener: HTMLElement | null = null;
  private positionFrame = 0;
  private geometry = '';
  private loadError = false;
  private selectedPromptId: string | null = null;
  private visiblePromptIds: string[] = [];
  private modalDeleteConfirm = false;
  private modalDeleteTimer: number | null = null;
  private editingPrompt: Prompt | null = null;

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

    promptStore.subscribe(() => {
      this.loadError = false;
      if (this.isOpen) this.updateList();
    });

    document.addEventListener('mousedown', (event) => {
      if (!this.isOpen || this.isEditing()) return;
      const path = event.composedPath();
      if (!path.includes(this.host) && !path.includes(document.getElementById('gp-prompt-btn')!)) this.close();
    }, true);

    document.addEventListener('keydown', (event) => {
      if (!this.isOpen || event.isComposing || event.keyCode === 229) return;
      const editing = this.isEditing();
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (editing) this.closeModal();
        else this.close(true);
        return;
      }
      if (!event.composedPath().includes(this.host)) return;
      if (event.key === 'Tab') {
        const scope = this.shadow.querySelector(editing ? '#modal-overlay' : '.picker')!;
        const controls = Array.from(scope.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea'))
          .filter((control) => control.getClientRects().length > 0);
        const active = this.shadow.activeElement as HTMLElement;
        if (event.shiftKey && active === controls[0]) {
          event.preventDefault();
          controls.at(-1)?.focus();
        } else if (!event.shiftKey && active === controls.at(-1)) {
          event.preventDefault();
          controls[0]?.focus();
        }
        return;
      }
      if (editing) return;
      const target = event.composedPath()[0];
      if (!(target instanceof HTMLElement) || !target.matches('.search-input, .item-insert')) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        this.moveSelection(event.key === 'ArrowDown' ? 1 : -1);
      } else if (event.key === 'Enter' && (target.matches('.search-input') || event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        if (target.matches('.item-insert')) this.selectedPromptId = target.closest<HTMLElement>('.item')?.dataset.id ?? null;
        this.insertSelectedPrompt(event.ctrlKey || event.metaKey);
      }
    }, true);


  }

  public static getInstance(): PromptPicker {
    return PromptPicker.instance ??= new PromptPicker();
  }

  public isEditing(): boolean {
    return this.shadow.querySelector<HTMLElement>('#modal-overlay')?.dataset.gpMotionState === 'open';
  }

  public toggle(composer: HTMLElement, opener: HTMLElement | null) {
    if (this.isEditing()) return;
    if (this.isOpen) this.close(true);
    else this.open(captureComposer(composer), opener);
  }

  public open(session: ComposerSession, opener: HTMLElement | null) {
    if (this.isOpen) return;
    this.host.dataset.gpTheme = resolveGeminiTheme();
    this.isOpen = true;
    this.session = session;
    this.opener = opener;
    this.geometry = '';
    this.selectedPromptId = null;
    this.visiblePromptIds = [];
    this.searchQuery = '';

    this.host.style.display = 'block';
    this.host.style.pointerEvents = 'auto';
    const picker = this.shadow.querySelector<HTMLElement>('.picker')!;
    const input = this.shadow.querySelector<HTMLInputElement>('.search-input')!;
    input.value = '';
    this.shadow.querySelector<HTMLButtonElement>('.search-clear')!.hidden = true;
    showSurface(picker, 'menu', 'flex', () => this.updateList());
    input.focus({ preventScroll: true });
    this.positionPicker();
    void promptStore.refresh().catch(() => {
      this.loadError = true;
      if (this.isOpen) this.updateList();
    });
  }

  public close(restoreFocus = false) {
    const { session, opener } = this;
    this.isOpen = false;
    this.session = null;
    this.opener = null;
    cancelAnimationFrame(this.positionFrame);
    if (this.isEditing()) this.closeModal(false);
    this.host.style.pointerEvents = 'none';
    const picker = this.shadow.querySelector<HTMLElement>('.picker')!;
    hideSurface(picker, () => {
      if (!this.isOpen) this.host.style.display = 'none';
    });
    if (restoreFocus && session && isCurrentComposer(session)) {
      if (opener && opener !== session.composer && opener.isConnected) opener.focus();
      else restoreComposerFocus(session);
    }
  }

  private positionPicker = () => {
    const composer = this.session?.composer;
    if (!composer?.isConnected || this.session?.url !== location.href ||
        !composer.getClientRects().length) {
      this.close();
      return;
    }
    this.updatePosition();
    this.positionFrame = requestAnimationFrame(this.positionPicker);
  };

  private updatePosition() {
    if (!this.session) return;
    const picker = this.shadow.querySelector<HTMLElement>('.picker')!;
    const rect = this.session.composer.getBoundingClientRect();
    const margin = 12;
    const gap = 10;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.max(0, Math.min(400, viewportWidth - margin * 2));
    const left = Math.round(Math.max(margin, Math.min(rect.left, viewportWidth - width - margin)));
    // 侧栏过渡只改变输入区的位置，已打开的 Picker 仍需重新锚定。
    const geometry = [left, width, viewportHeight, Math.round(rect.top), Math.round(rect.bottom)].join();
    if (geometry === this.geometry) return;
    const widthChanged = picker.style.width !== `${width}px`;
    if (widthChanged) picker.style.width = `${width}px`;
    if (widthChanged || !this.geometry) this.applyDynamicHeight(picker);
    this.geometry = geometry;

    const height = picker.offsetHeight;
    const above = rect.top - gap - margin;
    const below = viewportHeight - rect.bottom - gap - margin;
    const placeAbove = height <= above || above >= below;
    const anchoredTop = placeAbove ? rect.top - gap - height : rect.bottom + gap;
    // 两侧都放不下时让浮层向视口内移动，只有视口高度不足时才滚动。
    const top = Math.round(Math.max(margin, Math.min(anchoredTop, viewportHeight - margin - height)));
    this.host.style.left = `${left}px`;
    this.host.style.top = `${top}px`;
    setSurfaceOrigin(picker, rect, left, top);
    this.syncListScrollFade(picker.querySelector<HTMLElement>('.list'));
  }

  private applyDynamicHeight(picker: HTMLElement) {
    const header = picker.querySelector<HTMLElement>('.header')!;
    const list = picker.querySelector<HTMLElement>('.list')!;
    const footer = picker.querySelector<HTMLElement>('.footer-action')!;
    const listPadding = parseFloat(getComputedStyle(list).paddingBottom);
    const rows = Array.from(list.children).slice(0, 4);
    const listHeight = rows.reduce((height, row) => {
      const styles = getComputedStyle(row);
      return height + parseFloat(styles.height) + parseFloat(styles.marginBottom);
    }, listPadding);
    const borders = picker.offsetHeight - picker.clientHeight;
    picker.style.height = `${Math.ceil(header.offsetHeight + listHeight + footer.offsetHeight + borders)}px`;
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
        width: 400px; max-height: calc(100dvh - 24px); position: relative;
        display: flex; flex-direction: column; overflow: hidden;
        background: var(--gp-surface); color: var(--gp-fg);
        border: .5px solid var(--gp-border); border-radius: var(--gp-radius-library);
        box-shadow: var(--gp-shadow);
        font-family: var(--gp-font-sans); font-size: 14px;
        --gp-motion-open: 150ms;
      }
      .picker[data-gp-motion-state="open"]:has(+ .modal-overlay[data-gp-motion-state="open"]) {
        opacity: 0; pointer-events: none; transform: scale(.97);
      }
      .header { padding: 18px var(--gp-library-inset) 12px; flex-shrink: 0; }
      .library-heading { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; padding-inline: 8px; gap: 8px; }
      .library-title, .modal-title { margin: 0; ${PANEL_TITLE_TYPOGRAPHY} }
      .library-count { font-size: 12px; color: var(--gp-fg-secondary); }
      .search-row { border: 1px solid var(--gp-control-border); border-radius: var(--gp-radius-pill); background: var(--gp-surface-sunken); transition: border-color var(--gp-transition), box-shadow var(--gp-transition); }
      .search-row:focus-within { border-color: var(--gp-focus-border); box-shadow: var(--gp-focus-ring); }
      .search-box { display: flex; align-items: center; height: 38px; padding: 0 8px 0 14px; gap: 8px; }
      .search-icon { display: flex; color: var(--gp-fg-secondary); }
      .search-input { min-width: 0; width: 100%; flex: 1; border: 0; background: transparent; padding: 0; outline: none; font-size: 14px; }
      .search-input:focus-visible { outline: none; }
      .search-clear { display: grid; place-items: center; flex: 0 0 28px; width: 28px; height: 28px; padding: 0; border: 0; border-radius: var(--gp-radius-circle); background: transparent; color: var(--gp-fg-secondary); }
      .search-clear[hidden] { display: none; }
      .search-clear:hover { background: var(--gp-bg-hover); color: var(--gp-fg); }
      .search-clear svg { width: 14px; height: 14px; }
      .search-input::placeholder { color: var(--gp-fg-tertiary); }
      .list { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 0 var(--gp-library-inset) 8px; scrollbar-width: thin; scrollbar-color: var(--gp-border) transparent; }
      .list[data-gp-fade-bottom] { mask-image: linear-gradient(to bottom, black calc(100% - 18px), transparent 100%); -webkit-mask-image: linear-gradient(to bottom, black calc(100% - 18px), transparent 100%); }
      .empty-box { min-height: 112px; display: grid; place-content: center; padding: 16px; text-align: center; color: var(--gp-fg-secondary); font-size: 14px; }
      .item { position: relative; border-radius: var(--gp-radius-library-item); margin-bottom: 4px; border: .5px solid transparent; transition: background var(--gp-transition); }
      .item:hover, .item.selected, .item:focus-within { background: var(--gp-bg-active); }
      .list:has(.item:hover) .item.selected:not(:hover):not(:focus-within) { background: transparent; }
      .list:has(.item:hover) .item.selected:not(:hover):not(:focus-within) .item-actions { opacity: 0; pointer-events: none; }
      .item-insert { display: block; width: 100%; border: 0; background: transparent; text-align: left; padding: 12px 14px; border-radius: inherit; }
      .item-content { min-width: 0; }
      .item-head { display: flex; align-items: center; min-height: 24px; padding-right: 36px; margin-bottom: 4px; }
      .item-title { font-size: 14px; line-height: 19.6px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .item-preview { font-size: 14px; line-height: 19.6px; color: var(--gp-fg-secondary); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
      .item-actions { position: absolute; top: 10px; right: 10px; display: flex; opacity: 0; pointer-events: none; transition: opacity var(--gp-transition); }
      .item:hover .item-actions, .item.selected .item-actions, .item:focus-within .item-actions { opacity: 1; pointer-events: auto; }
      .item-action-btn { width: 28px; height: 28px; display: grid; place-items: center; padding: 0; border: .5px solid var(--gp-border); border-radius: var(--gp-radius-circle); background: var(--gp-surface); color: var(--gp-fg-secondary); box-shadow: 0 1px 2px #0000000a; transition: background var(--gp-transition), color var(--gp-transition), box-shadow var(--gp-transition); }
      .item-action-btn:hover { background: var(--gp-bg-hover); color: var(--gp-fg); box-shadow: 0 2px 5px #00000014; }
      .item-action-btn svg { width: 14px; height: 14px; stroke-width: 1.75; }
      .footer-action, .modal-footer { flex-shrink: 0; border-top: 1px solid var(--gp-border); background: var(--gp-surface-footer); }
      .footer-action { padding: var(--gp-library-inset); }
      .footer-buttons { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .footer-hint { padding-left: 8px; font-size: 12px; line-height: 16.8px; color: var(--gp-fg-secondary); }
      .btn-orb { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: var(--gp-prompt-action-height); padding: 0 16px; border: .5px solid var(--gp-accent); border-radius: var(--gp-radius-pill); background: var(--gp-accent); color: var(--gp-accent-fg); font-size: 14px; font-weight: 600; transition: opacity var(--gp-transition); }
      .btn-orb:hover { opacity: .85; }
      .btn-orb svg { width: 16px; height: 16px; }
      .modal-overlay { position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: center; justify-content: center; padding: 16px; background: var(--gp-backdrop); backdrop-filter: var(--gp-backdrop-blur); }
      .modal { --gp-panel-inset: 24px; width: min(560px, 100%); max-height: calc(100dvh - 32px); display: flex; flex-direction: column; overflow: hidden; background: var(--gp-surface); border: .5px solid var(--gp-border); border-radius: var(--gp-radius-prompt-modal); box-shadow: var(--gp-shadow); font: 14px var(--gp-font-sans); color: var(--gp-fg); }
      .modal-header { display: flex; flex-shrink: 0; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 16px 0 var(--gp-panel-inset); }
      .modal-close { display: grid; place-items: center; flex: 0 0 32px; width: 32px; height: 32px; padding: 0; border: 0; border-radius: var(--gp-radius-circle); background: transparent; color: var(--gp-fg-secondary); }
      .modal-close:hover { background: var(--gp-bg-hover); }
      .modal-body { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 20px var(--gp-panel-inset) 22px; display: flex; flex-direction: column; gap: 20px; }
      .modal-body > * { flex-shrink: 0; }
      .form-group { display: flex; flex-direction: column; gap: 8px; }
      .form-label { font-size: 14px; line-height: 19.6px; font-weight: 600; }
      .form-input, .form-textarea { width: 100%; border: 1px solid var(--gp-control-border); background: var(--gp-surface-sunken); color: var(--gp-fg); font-size: 14px; line-height: 19.6px; transition: border-color var(--gp-transition), box-shadow var(--gp-transition); }
      .form-input { height: 40px; padding: 0 18px; border-radius: var(--gp-radius-pill); }
      .form-input:focus, .form-textarea:focus { outline: none; border-color: var(--gp-focus-border); box-shadow: var(--gp-focus-ring); }
      .form-input::placeholder, .form-textarea::placeholder { color: var(--gp-fg-tertiary); }
      .form-textarea { display: block; height: clamp(120px, 28vh, 260px); resize: none; padding: 14px 18px; border-radius: var(--gp-radius-prompt-textarea); }
      .content-label { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
      .textarea-token { color: var(--gp-fg-tertiary); font-size: 12px; white-space: nowrap; }
      .modal-footer { padding: var(--gp-prompt-footer-inset); display: flex; justify-content: space-between; align-items: center; gap: 8px; }
      .modal-footer-left, .modal-footer-right { display: flex; align-items: center; gap: 8px; }
      .modal-footer-right { margin-left: auto; }
      .modal-footer .btn { white-space: nowrap; }
      @media (max-width: 400px) { .modal-footer .btn { padding-inline: 10px; } }
      .btn { height: var(--gp-prompt-action-height); padding: 0 16px; border-radius: var(--gp-radius-pill); border: 1px solid var(--gp-border); font-size: 14px; font-weight: 500; color: var(--gp-fg-secondary); background: transparent; transition: background var(--gp-transition), border-color var(--gp-transition), color var(--gp-transition), opacity var(--gp-transition); }
      .btn:hover:not(:disabled) { background: var(--gp-bg-hover); color: var(--gp-fg); }
      .btn-save { border-color: var(--gp-accent); background: var(--gp-accent); color: var(--gp-accent-fg); font-weight: 600; }
      .btn-save:hover:not(:disabled) { background: var(--gp-accent); color: var(--gp-accent-fg); opacity: .88; }
      .btn-save:disabled { background: var(--gp-bg-hover); border-color: var(--gp-border); color: var(--gp-fg-tertiary); opacity: 1; cursor: not-allowed; }
      .btn-delete { color: var(--gp-danger); border-color: transparent; }
      .btn-delete:hover:not(:disabled) { color: var(--gp-danger); }
      .btn-delete.confirming { border-color: var(--gp-danger); }
      .form-status { margin: 0; padding: 0 var(--gp-panel-inset) 12px; font-size: 12px; color: var(--gp-danger); }
      .form-status:empty { display: none; }
      @media (max-width: 400px) {
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
    const list = this.shadow.getElementById('list-container');
    list?.addEventListener('scroll', () => this.syncListScrollFade(list), { passive: true });
  }

  private syncListScrollFade(list: HTMLElement | null) {
    if (!list) return;
    const hasMoreBelow = list.scrollHeight - list.scrollTop - list.clientHeight > 6;
    list.toggleAttribute('data-gp-fade-bottom', hasMoreBelow);
  }

  private showModal(prompt?: Prompt) {
    this.editorOpener = this.shadow.activeElement as HTMLElement | null;
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
      <div class="modal" data-gp-motion-surface role="dialog" aria-modal="true" aria-labelledby="prompt-editor-title">
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
            <div class="content-label">
              <label class="form-label" for="prompt-content">Prompt Content</label>
              <span class="textarea-token" id="content-token-estimate">~0 tokens</span>
            </div>
            <textarea class="form-textarea" id="prompt-content" placeholder="Enter your prompt template...">${safeContent}</textarea>
          </div>
        </div>
        <p class="form-status" id="form-status" role="alert"></p>
        <div class="modal-footer">
          <div class="modal-footer-left">
            ${prompt ? '<button class="btn btn-delete" data-gp-press id="modal-delete">Delete</button>' : ''}
          </div>
          <div class="modal-footer-right">
            <button class="btn btn-cancel" data-gp-press id="modal-cancel">Cancel</button>
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
    titleInput?.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        if (!saveBtn?.disabled) void this.savePrompt();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        contentInput?.focus();
      }
    });
    contentInput?.addEventListener('input', () => {
      updateContentMeta();
      updateSaveEnabled();
    });
    contentInput?.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        if (!saveBtn?.disabled) void this.savePrompt();
      }
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
        deleteBtn.textContent = 'Confirm';
        deleteBtn.setAttribute('aria-label', 'Confirm Delete');
        deleteBtn.classList.add('confirming');
        if (this.modalDeleteTimer) {
          window.clearTimeout(this.modalDeleteTimer);
        }
        this.modalDeleteTimer = window.setTimeout(() => {
          this.modalDeleteConfirm = false;
          this.modalDeleteTimer = null;
          deleteBtn.textContent = 'Delete';
          deleteBtn.removeAttribute('aria-label');
          deleteBtn.classList.remove('confirming');
        }, 2200);
        return;
      }

      if (this.modalDeleteTimer) {
        window.clearTimeout(this.modalDeleteTimer);
        this.modalDeleteTimer = null;
      }
      const status = overlay.querySelector<HTMLElement>('#form-status')!;
      const deletingId = this.editingPrompt.id;
      deleteBtn.disabled = true;
      if (saveBtn) saveBtn.disabled = true;
      try {
        await promptStore.delete(deletingId);
        if (status.isConnected && this.isEditing()) this.closeModal();
      } catch {
        status.textContent = 'Could not delete this prompt. Please try again.';
        deleteBtn.disabled = false;
        updateSaveEnabled();
      }
    });

    overlay.onclick = (e) => {
      if (e.target === overlay) this.closeModal();
    };

    setTimeout(() => {
      if (overlay.dataset.gpMotionState === 'open') titleInput?.focus();
    }, 50);
  }

  private closeModal(restoreFocus = true) {
    const overlay = this.shadow.getElementById('modal-overlay') as HTMLElement;
    hideSurface(overlay, () => { overlay.innerHTML = ''; });
    this.shadow.querySelector('.picker')?.removeAttribute('inert');
    if (restoreFocus) {
      const opener = this.editorOpener;
      const replacement = this.editingPrompt && Array.from(this.shadow.querySelectorAll<HTMLButtonElement>('.item-action-btn'))
        .find((button) => button.dataset.id === this.editingPrompt?.id);
      (opener?.isConnected ? opener : replacement || this.shadow.querySelector<HTMLButtonElement>('.btn-new'))?.focus();
    }
    this.editorOpener = null;
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

    if (this.shadow.querySelector<HTMLButtonElement>('#modal-save')?.disabled) return;
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
      if (status?.isConnected && this.isEditing()) this.closeModal();
    } catch {
      if (status) status.textContent = 'Could not save this prompt. Your draft is still here; please try again.';
    } finally {
      if (saveButton) {
        saveButton.disabled = false;
        saveButton.textContent = 'Save';
      }
    }
  }

  private moveSelection(step: number, followFocus = true) {
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
        if (followFocus && this.shadow.activeElement?.classList.contains('item-insert')) {
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

    const focused = this.shadow.activeElement as HTMLElement | null;
    const focusedId = focused?.closest<HTMLElement>('.item')?.dataset.id;
    list.replaceChildren();
    this.visiblePromptIds = displayPrompts.map((prompt) => prompt.id);
    const count = this.shadow.getElementById('library-count');
    if (count) count.textContent = `${displayPrompts.length} ${displayPrompts.length === 1 ? 'prompt' : 'prompts'}`;

    if (displayPrompts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-box';
      empty.textContent = this.loadError ? 'Could not load prompts. Reopen to try again.'
        : this.searchQuery ? 'No matching prompts' : 'Your library is empty. Add your first prompt.';
      if (this.loadError) empty.setAttribute('role', 'status');
      list.appendChild(empty);
      this.selectedPromptId = null;
      this.geometry = '';
      this.updatePosition();
      this.syncListScrollFade(list);
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
      editBtn.setAttribute('aria-label', `Edit ${prompt.title}`);
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
        this.moveSelection(0, false);
      });

      list.appendChild(item);
      if (focusedId === prompt.id) {
        (focused?.classList.contains('item-action-btn') ? editBtn : insertButton).focus({ preventScroll: true });
      }
    });
    this.geometry = '';
    this.updatePosition();
    this.syncListScrollFade(list);
  }

  private onSelect(prompt: Prompt, keepOpen: boolean) {
    if (!this.session || this.isEditing()) return;
    if (!insertPrompt(this.session, prompt.content)) {
      this.close();
      return;
    }
    void promptStore.trackUsage(prompt.id).catch((error) =>
      console.warn('[Gemini Projects] Could not record prompt usage', error));
    if (keepOpen) {
      this.session = captureComposer(this.session.composer);
      this.searchQuery = '';
      const input = this.shadow.querySelector<HTMLInputElement>('.search-input')!;
      input.value = '';
      this.shadow.querySelector<HTMLButtonElement>('.search-clear')!.hidden = true;
      input.focus();
      this.updateList();
    } else {
      this.close();
    }
  }
}
