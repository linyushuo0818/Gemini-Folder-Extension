
import { Prompt, promptStore } from './store';
import { PANEL_TITLE_FONT_STACK, PANEL_TITLE_TYPOGRAPHY } from '../ui/typography';

const PICKER_ID = 'gp-prompt-picker-root';

// Icons
const ICONS = {
  search: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>`,
  close: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
  edit: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>`,
  tag: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z"/><circle cx="7.5" cy="7.5" r="1"/></svg>`,
  back: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>`,
  library: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4h12v16H8a2 2 0 0 1-2-2Z"/><path d="M8 4v14"/><path d="M10 8h5"/></svg>`,
  filter: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16"/><path d="M7 12h10"/><path d="M10 19h4"/></svg>`,
  check: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4 4L19 6"/></svg>`,
  settings: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.1a2 2 0 0 1-1-1.72v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`
};

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
  private pendingDeletePromptId: string | null = null;
  private inlineEditDraft: { id: string; title: string; content: string } | null = null;
  private themeObserver: MutationObserver | null = null;
  private modalDeleteConfirm = false;
  private modalDeleteTimer: number | null = null;

  // Modal 鐘舵€?
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
    this.syncTheme();
    this.startThemeObserver();

    promptStore.subscribe(() => this.updateList());

    // 鍏ㄥ眬鍏抽棴鐩戝惉
    document.addEventListener('mousedown', (e) => {
      if (this.isOpen) {
        const path = e.composedPath();
        const inHost = path.includes(this.host);
        if (!inHost && !(e.target as HTMLElement).closest('[data-gp-prompt-btn]')) {
          // 濡傛灉 Modal 鎵撳紑锛屼笉鍏抽棴 Picker
          const modal = this.shadow.querySelector('.modal-overlay');
          if (modal && (modal as HTMLElement).style.display !== 'none') return;
          this.close();
        }
      }
    }, true);

    document.addEventListener('keydown', (e) => {
      if (!this.isOpen) return;
      const modal = this.shadow.querySelector('.modal-overlay') as HTMLElement | null;
      const modalOpen = !!modal && modal.style.display !== 'none';

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (modalOpen) {
          this.closeModal();
        } else {
          this.close();
          document.querySelector<HTMLButtonElement>('[data-gp-prompt-btn]')?.focus();
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
            e.preventDefault(); last?.focus();
          } else if (!e.shiftKey && (active === last || !controls.includes(active as HTMLElement))) {
            e.preventDefault(); first?.focus();
          }
        }
        return;
      }
      const target = e.composedPath()[0] as HTMLElement;
      if (!target.closest('.search-input, .item-insert') || target.closest('.inline-editor')) return;

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

  public toggle(rect: DOMRect) {
    if (this.isOpen) {
      this.close();
    } else {
      this.open(rect);
    }
  }

  public open(rect: DOMRect) {
    this.syncTheme();
    this.isOpen = true;
    this.triggerRect = rect;
    this.selectedPromptId = null;
    this.pendingDeletePromptId = null;
    this.visiblePromptIds = [];
    this.inlineEditDraft = null;
    this.searchQuery = '';

    this.host.style.display = 'block';
    this.host.style.pointerEvents = 'auto';

    // Animate in
    const picker = this.shadow.querySelector('.picker');
    if (picker) {
      // Force reflow
      void (picker as HTMLElement).offsetWidth;
      picker.classList.add('open');
    }

    this.updatePosition();
    this.updateList();
    const input = this.shadow.querySelector('.search-input') as HTMLInputElement;
    if (input) {
      input.value = '';
      input.focus();
    }
  }

  public close() {
    this.isOpen = false;
    this.pendingDeletePromptId = null;
    this.inlineEditDraft = null;

    const picker = this.shadow.querySelector('.picker');
    if (picker) picker.classList.remove('open');

    // Wait for animation
    setTimeout(() => {
      if (!this.isOpen) {
        this.host.style.display = 'none';
        this.host.style.pointerEvents = 'none';
      }
    }, 200);
  }

  private updatePosition() {
    if (!this.triggerRect) return;
    const margin = 12;
    const gap = 12;
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
    let top = this.triggerRect.bottom + gap;
    let pointerSide: 'left' | 'right' | 'none' = 'none';

    if (mobile) {
      left = margin;
      top = viewportHeight - height - 16;
    } else {
      const rightSide = this.triggerRect.right + gap;
      const leftSide = this.triggerRect.left - width - gap;
      const canShowRight = rightSide + width <= viewportWidth - margin;
      const canShowLeft = leftSide >= margin;

      if (canShowRight) {
        left = rightSide;
        pointerSide = 'left';
      } else if (canShowLeft) {
        left = leftSide;
        pointerSide = 'right';
      } else {
        const centered = this.triggerRect.left + this.triggerRect.width / 2 - width / 2;
        left = Math.max(margin, Math.min(centered, viewportWidth - width - margin));
        pointerSide = 'none';
      }

      const preferredTop = this.triggerRect.top - 12;
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
      picker.classList.remove('anchor-left', 'anchor-right', 'anchor-none');
      picker.classList.add(pointerSide === 'left' ? 'anchor-left' : pointerSide === 'right' ? 'anchor-right' : 'anchor-none');
      const pointerTop = Math.max(
        28,
        Math.min(
          this.triggerRect.top + this.triggerRect.height / 2 - top,
          height - 28
        )
      );
      picker.style.setProperty('--gp-pointer-top', `${Math.round(pointerTop)}px`);
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

  private startThemeObserver() {
    if (this.themeObserver) return;
    this.themeObserver = new MutationObserver(() => this.syncTheme());
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme']
    });
    if (document.body) {
      this.themeObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ['class', 'style', 'data-theme']
      });
    }
  }

  private syncTheme() {
    this.host.dataset.gpTheme = this.resolveTheme();
  }

  private resolveTheme(): 'light' | 'dark' {
    const html = document.documentElement;
    const body = document.body;
    const classes = `${html.className} ${body?.className || ''}`.toLowerCase();

    if (/\b(light|theme-light)\b/.test(classes)) return 'light';
    if (/\b(dark|theme-dark|dark-theme)\b/.test(classes)) return 'dark';

    const sample = [body, html]
      .map((node) => (node ? getComputedStyle(node).backgroundColor : ''))
      .find((c) => c && c !== 'transparent');
    if (!sample) return 'light';

    const rgb = sample.match(/\d+(\.\d+)?/g);
    if (!rgb || rgb.length < 3) return 'light';
    const [r, g, b] = rgb.slice(0, 3).map(Number);
    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return luminance < 0.45 ? 'dark' : 'light';
  }

  private getStyles(): string {
    return `
      :host {
        --gp-font-serif: ${PANEL_TITLE_FONT_STACK};
        --gp-font-sans: "Anthropic Sans Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        --gp-surface: #ffffff;
        --gp-surface-elevated: #faf9f5;
        --gp-fg: #141413;
        --gp-fg-secondary: #3d3d3a;
        --gp-fg-tertiary: #73726c;
        --gp-border: rgb(31 30 29 / .15);
        --gp-control-border: rgb(31 30 29 / .3);
        --gp-button-border: rgb(31 30 29 / .4);
        --gp-bg-hover: #f5f4ed;
        --gp-bg-active: #f5f4ed;
        --gp-accent: #141413;
        --gp-accent-fg: #faf9f5;
        --gp-focus: rgb(20 20 19 / .7);
        --gp-danger: #9d4435;
        --gp-radius-lg: 28px;
        --gp-radius-md: 16px;
        --gp-radius-sm: 8px;
        --gp-radius-control: 12px;
        --gp-radius-pill: 999px;
        --gp-transition: .18s ease;
        font-family: var(--gp-font-sans);
        color: var(--gp-fg);
        color-scheme: light;
      }
      :host([data-gp-theme="dark"]) {
        --gp-surface: #30302e;
        --gp-surface-elevated: #262624;
        --gp-fg: #faf9f5;
        --gp-fg-secondary: #c2c0b6;
        --gp-fg-tertiary: #9c9a92;
        --gp-border: rgb(222 220 209 / .15);
        --gp-control-border: rgb(222 220 209 / .3);
        --gp-button-border: rgb(222 220 209 / .4);
        --gp-bg-hover: #3d3d3a;
        --gp-bg-active: #3d3d3a;
        --gp-accent: #faf9f5;
        --gp-accent-fg: #141413;
        --gp-focus: rgb(250 249 245 / .7);
        --gp-danger: #e0a28b;
        color-scheme: dark;
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
        border: .5px solid var(--gp-border); border-radius: var(--gp-radius-lg);
        box-shadow: 0 16px 48px #00000026, 0 4px 12px #00000012;
        font-family: var(--gp-font-sans); font-size: 14px;
        opacity: 0; transform: translateY(6px); pointer-events: none;
        transition: opacity var(--gp-transition), transform var(--gp-transition);
      }
      .picker.open { opacity: 1; transform: translateY(0); pointer-events: auto; }
      .header { padding: 20px 16px 16px; flex-shrink: 0; }
      .library-heading { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; gap: 8px; }
      .library-title, .modal-title { margin: 0; ${PANEL_TITLE_TYPOGRAPHY} }
      .library-count { font-size: 12px; color: var(--gp-fg-secondary); }
      .search-row { border: 1px solid var(--gp-control-border); border-radius: var(--gp-radius-control); background: var(--gp-surface); }
      .search-row:focus-within { border-color: var(--gp-focus); box-shadow: 0 0 0 1px var(--gp-focus); }
      .search-box { display: flex; align-items: center; height: 38px; padding: 0 12px; gap: 8px; }
      .search-icon { display: flex; color: var(--gp-fg-secondary); }
      .search-input { min-width: 0; width: 100%; flex: 1; border: 0; background: transparent; padding: 0; outline: none; font-size: 14px; }
      .search-input:focus-visible { outline: none; }
      .search-input::placeholder { color: var(--gp-fg-tertiary); }
      .list { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 0 12px 8px; scrollbar-width: thin; scrollbar-color: var(--gp-border) transparent; }
      .empty-box { min-height: 100px; display: grid; place-content: center; padding: 16px; text-align: center; color: var(--gp-fg-secondary); font-size: 14px; }
      .item { position: relative; border-radius: var(--gp-radius-md); margin-bottom: 4px; border: .5px solid transparent; transition: background var(--gp-transition); }
      .item:hover, .item.selected, .item:focus-within { background: var(--gp-bg-active); }
      .list:has(.item:hover) .item.selected:not(:hover):not(:focus-within) { background: transparent; }
      .list:has(.item:hover) .item.selected:not(:hover):not(:focus-within) .item-actions { opacity: 0; pointer-events: none; }
      .item-insert { display: block; width: 100%; border: 0; background: transparent; text-align: left; padding: 12px; border-radius: var(--gp-radius-md); }
      .item-content { min-width: 0; }
      .item-head { display: flex; align-items: center; min-height: 24px; padding-right: 40px; margin-bottom: 4px; }
      .item-title { font-size: 14px; line-height: 19.6px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .item-preview { font-size: 14px; line-height: 19.6px; color: var(--gp-fg-secondary); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
      .item-actions { position: absolute; top: 8px; right: 8px; display: flex; opacity: 0; pointer-events: none; transition: opacity var(--gp-transition); }
      .item:hover .item-actions, .item.selected .item-actions, .item:focus-within .item-actions { opacity: 1; pointer-events: auto; }
      .item-action-btn { width: 32px; height: 32px; display: grid; place-items: center; padding: 0; border: .5px solid var(--gp-border); border-radius: calc(var(--gp-radius-md) - 8px); background: var(--gp-surface-elevated); color: var(--gp-fg-secondary); box-shadow: 0 1px 2px #0000000a; transition: background var(--gp-transition), color var(--gp-transition), box-shadow var(--gp-transition); }
      .item-action-btn:hover { background: var(--gp-surface); color: var(--gp-fg); box-shadow: 0 2px 5px #00000014; }
      .item-action-btn svg { width: 16px; height: 16px; stroke-width: 1.75; }
      .footer-action { flex-shrink: 0; padding: 16px; border-top: .5px solid var(--gp-border); }
      .footer-buttons { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .footer-hint { font-size: 12px; line-height: 16.8px; color: var(--gp-fg-secondary); }
      .btn-orb { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 36px; padding: 0 16px; border: .5px solid var(--gp-accent); border-radius: var(--gp-radius-control); background: var(--gp-accent); color: var(--gp-accent-fg); font-size: 14px; font-weight: 600; transition: opacity var(--gp-transition); }
      .btn-orb:hover { opacity: .85; }
      .btn-orb svg { width: 16px; height: 16px; }
      .modal-overlay { position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: center; justify-content: center; padding: 16px; background: #14141366; }
      .modal { width: min(560px, 100%); max-height: calc(100dvh - 32px); display: flex; flex-direction: column; background: var(--gp-surface); border: .5px solid var(--gp-border); border-radius: var(--gp-radius-lg); box-shadow: 0 16px 48px #00000033; font: 14px var(--gp-font-sans); color: var(--gp-fg); animation: modalFadeIn .18s ease; }
      @keyframes modalFadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
      .modal-header { display: flex; align-items: center; justify-content: space-between; padding: 16px; border-bottom: .5px solid var(--gp-border); }
      .modal-close { display: grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 0; border-radius: var(--gp-radius-sm); background: transparent; color: var(--gp-fg-secondary); }
      .modal-close:hover { background: var(--gp-bg-hover); }
      .modal-body { min-height: 0; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 16px; }
      .form-group { display: flex; flex-direction: column; gap: 8px; }
      .form-label { font-size: 14px; line-height: 19.6px; font-weight: 600; }
      .form-input, .form-textarea, .inline-editor-input, .inline-editor-textarea { width: 100%; border: .5px solid var(--gp-control-border); border-radius: var(--gp-radius-control); background: var(--gp-surface); color: var(--gp-fg); padding: 10px 12px; font-size: 14px; line-height: 19.6px; }
      .form-input { height: 40px; border-width: 1px; }
      .form-input::placeholder, .form-textarea::placeholder { color: var(--gp-fg-tertiary); }
      .textarea-shell { position: relative; }
      .form-textarea { display: block; height: clamp(120px, 28vh, 260px); resize: vertical; padding: 16px 16px 40px; }
      .textarea-token { position: absolute; right: 16px; bottom: 16px; font: 12px "JetBrains Mono", ui-monospace, monospace; color: var(--gp-fg-secondary); pointer-events: none; }
      .modal-footer { padding: 16px; border-top: .5px solid var(--gp-border); display: flex; justify-content: space-between; align-items: center; gap: 8px; }
      .modal-footer-left, .modal-footer-right { display: flex; align-items: center; gap: 8px; }
      .modal-footer-right { margin-left: auto; }
      .btn, .inline-editor-btn { height: 36px; padding: 0 16px; border-radius: var(--gp-radius-control); border: .5px solid var(--gp-button-border); font-size: 14px; font-weight: 600; background: transparent; }
      .btn:hover { background: var(--gp-bg-hover); }
      .btn-save, .inline-editor-btn.primary { border-color: var(--gp-accent); background: var(--gp-accent); color: var(--gp-accent-fg); }
      .btn-save:hover { background: var(--gp-accent); opacity: .85; }
      .btn-delete { color: var(--gp-danger); border-color: transparent; }
      .btn-delete.confirming { border-color: var(--gp-danger); }
      .form-status { margin: 0; padding: 0 16px 12px; font-size: 12px; color: var(--gp-danger); }
      .form-status:empty { display: none; }
      .inline-editor { display: flex; flex-direction: column; gap: 12px; padding: 12px; }
      .inline-editor-row { display: flex; flex-direction: column; gap: 8px; }
      .inline-editor-label { font-size: 12px; }
      .inline-editor-textarea { min-height: 100px; }
      .inline-editor-actions { display: flex; justify-content: flex-end; gap: 8px; }
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
            </div>
          </div>
        </div>
        <div class="list" id="list-container"></div>
        <div class="footer-action">
          <div class="footer-buttons">
            <span class="footer-hint">Select to insert</span>
            <div class="primary-cluster">
              <button class="btn-orb btn-new" id="btn-primary-action" title="New Prompt">
                ${ICONS.plus} <span>New Prompt</span>
              </button>
            </div>
          </div>
        </div>
      </div>
      <div class="modal-overlay" id="modal-overlay" style="display:none;"></div>
    `;

    // 鎼滅储缁戝畾
    const input = this.shadow.querySelector('.search-input') as HTMLInputElement;
    input?.addEventListener('input', (e) => {
      this.searchQuery = (e.target as HTMLInputElement).value.toLowerCase();
      this.updateList();
    });
    // 闃绘鍐呴儴鐐瑰嚮鍏抽棴 Picker
    const header = this.shadow.querySelector('.header');
    header?.addEventListener('mousedown', (e) => e.stopPropagation());

    this.shadow.getElementById('btn-primary-action')?.addEventListener('click', () => {
      this.inlineEditDraft = null;
      this.showModal();
      this.updateList();
    });
    this.refreshPickerControls();
  }

  // ===================== Modal Methods =====================
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
    overlay.style.display = 'flex';
    this.shadow.querySelector('.picker')?.setAttribute('inert', '');
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="prompt-editor-title" aria-label="${prompt ? 'Edit Prompt' : 'New Prompt'}">
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
        <p class="form-status" id="form-status" role="status"></p>
        <div class="modal-footer">
          <div class="modal-footer-left">
            ${prompt ? '<button class="btn btn-delete" id="modal-delete">Delete</button>' : ''}
          </div>
          <div class="modal-footer-right">
            <button class="btn btn-cancel" id="modal-cancel">Cancel</button>
            <button class="btn btn-save" id="modal-save">Save</button>
          </div>
        </div>
      </div>
    `;

    // 缁戝畾浜嬩欢
    const titleInput = overlay.querySelector('#prompt-title') as HTMLInputElement | null;
    const contentInput = overlay.querySelector('#prompt-content') as HTMLTextAreaElement | null;
    const tokenEstimateEl = overlay.querySelector('#content-token-estimate') as HTMLElement | null;
    const saveBtn = overlay.querySelector('#modal-save') as HTMLButtonElement | null;
    const updateContentMeta = () => {
      const chars = (contentInput?.value || '').length;
      const tokenEstimate = Math.ceil(chars / 4);
      if (tokenEstimateEl) tokenEstimateEl.textContent = `~${tokenEstimate} tokens`;
    };
    const updateSaveEnabled = () => {
      const currentTitle = (titleInput?.value || '').trim();
      const currentContent = (contentInput?.value || '').trim();
      if (saveBtn) {
        saveBtn.disabled = !(currentTitle.length > 0 && currentContent.length > 0);
      }
    };

    titleInput?.addEventListener('input', () => {
      updateSaveEnabled();
    });
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

    // 鐐瑰嚮 overlay 鑳屾櫙鍏抽棴
    overlay.onclick = (e) => {
      if (e.target === overlay) this.closeModal();
    };

    // 鑱氱劍 Title
    setTimeout(() => {
      titleInput?.focus();
    }, 50);
  }

  private closeModal() {
    const overlay = this.shadow.getElementById('modal-overlay') as HTMLElement;
    overlay.style.display = 'none';
    overlay.innerHTML = '';
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

    if (!title || !content) {
      alert('Please fill in Name and Prompt Content.');
      return;
    }

    const now = Date.now();
    const promptData: Prompt = {
      id: this.editingPrompt?.id || crypto.randomUUID(),
      title,
      content,
      tags: [],
      createdAt: this.editingPrompt?.createdAt || now,
      updatedAt: now,
      usageCount: this.editingPrompt?.usageCount || 0,
      lastUsedAt: this.editingPrompt?.lastUsedAt || 0,
      isFavorite: this.editingPrompt?.isFavorite || false
    };

    const saveButton = this.shadow.getElementById('modal-save') as HTMLButtonElement | null;
    const status = this.shadow.getElementById('form-status');
    if (saveButton) { saveButton.disabled = true; saveButton.textContent = 'Saving…'; }
    if (status) status.textContent = '';
    try {
      await promptStore.save(promptData);
      this.closeModal();
      this.updateList();
      this.shadow.querySelector<HTMLButtonElement>('.btn-new')?.focus();
    } catch {
      if (status) status.textContent = 'Could not save this prompt. Your draft is still here; please try again.';
    } finally {
      if (saveButton) { saveButton.disabled = false; saveButton.textContent = 'Save'; }
    }
  }

  private startInlineEdit(prompt: Prompt) {
    this.inlineEditDraft = {
      id: prompt.id,
      title: prompt.title,
      content: prompt.content
    };
    this.selectedPromptId = prompt.id;
    this.updateList();
  }

  private cancelInlineEdit() {
    this.inlineEditDraft = null;
    this.updateList();
  }

  private async saveInlineEdit() {
    const draft = this.inlineEditDraft;
    if (!draft) return;
    const title = draft.title.trim();
    const content = draft.content.trim();
    if (!title || !content) {
      alert('Please fill in both title and content');
      return;
    }

    const existing = promptStore.get(draft.id);
    if (!existing) {
      this.inlineEditDraft = null;
      this.updateList();
      return;
    }

    await promptStore.save({
      ...existing,
      id: existing.id,
      title,
      content,
      tags: []
    });
    this.inlineEditDraft = null;
    this.updateList();
  }

  private refreshPickerControls() {
    const primaryAction = this.shadow.getElementById('btn-primary-action') as HTMLButtonElement | null;
    const footerHint = this.shadow.getElementById('footer-hint') as HTMLElement | null;
    const searchInput = this.shadow.querySelector('.search-input') as HTMLInputElement | null;

    if (primaryAction) {
      primaryAction.innerHTML = `${ICONS.plus}<span>New Prompt</span>`;
      primaryAction.title = 'New Prompt';
    }
    if (footerHint) footerHint.style.display = 'none';
    if (searchInput) {
      searchInput.placeholder = 'Search prompts...';
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
    const list = promptStore.getAll();
    const prompt = list.find((item) => item.id === this.selectedPromptId);
    if (!prompt) return;
    this.onSelect(prompt, keepOpen);
  }

  // ===================== List Methods =====================
  private updateList() {
    const list = this.shadow.getElementById('list-container');
    if (!list) return;
    this.refreshPickerControls();

    const allPrompts = promptStore.getAll();
    const filtered = allPrompts.filter(p => {
      const matchesSearch = p.title.toLowerCase().includes(this.searchQuery) ||
        p.content.toLowerCase().includes(this.searchQuery);
      return matchesSearch;
    });

    // List
    list.replaceChildren();
    const displayPrompts = filtered;
    this.visiblePromptIds = displayPrompts.map((prompt) => prompt.id);
    this.lastVisibleCount = displayPrompts.length;
    const count = this.shadow.getElementById('library-count');
    if (count) count.textContent = `${displayPrompts.length} ${displayPrompts.length === 1 ? 'prompt' : 'prompts'}`;
    if (this.pendingDeletePromptId && !this.visiblePromptIds.includes(this.pendingDeletePromptId)) {
      this.pendingDeletePromptId = null;
    }

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
      item.className = 'item';
      item.classList.add('library');
      if (this.selectedPromptId === prompt.id) {
        item.classList.add('selected');
      }
      item.dataset.id = prompt.id;

      const draft = this.inlineEditDraft;
      if (draft && draft.id === prompt.id) {
        item.classList.add('editing');
        const editor = document.createElement('div');
        editor.className = 'inline-editor';

        const titleRow = document.createElement('div');
        titleRow.className = 'inline-editor-row';
        const titleLabel = document.createElement('label');
        titleLabel.className = 'inline-editor-label';
        titleLabel.textContent = 'Title';
        const titleInput = document.createElement('input');
        titleInput.className = 'inline-editor-input';
        titleInput.type = 'text';
        titleInput.value = draft.title;
        titleInput.addEventListener('input', () => {
          if (!this.inlineEditDraft) return;
          this.inlineEditDraft.title = titleInput.value;
        });
        titleRow.appendChild(titleLabel);
        titleRow.appendChild(titleInput);

        const contentRow = document.createElement('div');
        contentRow.className = 'inline-editor-row';
        const contentLabel = document.createElement('label');
        contentLabel.className = 'inline-editor-label';
        contentLabel.textContent = 'Content';
        const contentInput = document.createElement('textarea');
        contentInput.className = 'inline-editor-textarea';
        contentInput.value = draft.content;
        contentInput.addEventListener('input', () => {
          if (!this.inlineEditDraft) return;
          this.inlineEditDraft.content = contentInput.value;
        });
        contentInput.addEventListener('keydown', (e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            this.saveInlineEdit();
          }
        });
        contentRow.appendChild(contentLabel);
        contentRow.appendChild(contentInput);

        const actionRow = document.createElement('div');
        actionRow.className = 'inline-editor-actions';
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'inline-editor-btn';
        cancelBtn.type = 'button';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => this.cancelInlineEdit());
        const saveBtn = document.createElement('button');
        saveBtn.className = 'inline-editor-btn primary';
        saveBtn.type = 'button';
        saveBtn.textContent = 'Save';
        saveBtn.addEventListener('click', () => this.saveInlineEdit());
        actionRow.appendChild(cancelBtn);
        actionRow.appendChild(saveBtn);

        editor.appendChild(titleRow);
        editor.appendChild(contentRow);
        editor.appendChild(actionRow);
        item.appendChild(editor);
        item.addEventListener('click', (e) => e.stopPropagation());
        list.appendChild(item);
        setTimeout(() => titleInput.focus(), 0);
        return;
      }

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
        this.pendingDeletePromptId = null;
        this.inlineEditDraft = null;
        this.showModal(prompt);
      });

      actions.appendChild(editBtn);
      item.appendChild(actions);
      item.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (target.closest('.item-actions')) return;
        this.pendingDeletePromptId = null;
        this.selectedPromptId = prompt.id;
        this.onSelect(prompt, false);
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

  private async insertPromptContent(text: string): Promise<boolean> {
    try {
      const mod = await import('./composer');
      const inserted = mod.insertPrompt(text);
      if (inserted === false) {
        return this.insertPromptFallback(text);
      }
      return true;
    } catch {
      return this.insertPromptFallback(text);
    }
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
    const inserted = await this.insertPromptContent(prompt.content);
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




