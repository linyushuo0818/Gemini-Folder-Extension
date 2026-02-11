
import { Prompt, promptStore } from './store';
import { exportAllData, triggerImport } from '../../shared/backup';
import { runtimeSendMessage } from '../../shared/webext';

const PICKER_ID = 'gp-prompt-picker-root';

// Icons
const ICONS = {
  search: `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path fill-rule="evenodd" d="M10.5 3a7.5 7.5 0 0 1 5.92 12.1l4.24 4.24-1.42 1.42-4.24-4.24A7.5 7.5 0 1 1 10.5 3Zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z" clip-rule="evenodd"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>`,
  close: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="m6.34 4.93-1.41 1.41L10.59 12l-5.66 5.66 1.41 1.41L12 13.41l5.66 5.66 1.41-1.41L13.41 12l5.66-5.66-1.41-1.41L12 10.59 6.34 4.93Z"/></svg>`,
  edit: `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M3 17.25V21h3.75l11.06-11.06-3.75-3.75L3 17.25Zm2.92 2.33H5v-1.17l8.06-8.06 1.17 1.17-8.31 8.06ZM20.71 7.04a1 1 0 0 0 0-1.41L18.37 3.29a1 1 0 0 0-1.41 0L15.13 5.12l3.75 3.75 1.83-1.83Z"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M9 3.8A2.2 2.2 0 0 0 6.8 6H4.5a1 1 0 1 0 0 2h.7l.8 10.8A2.2 2.2 0 0 0 8.2 21h7.6a2.2 2.2 0 0 0 2.2-2.2L18.8 8h.7a1 1 0 1 0 0-2h-2.3A2.2 2.2 0 0 0 15 3.8H9Zm6.2 2.2H8.8V6a.2.2 0 0 1 .2-.2h6a.2.2 0 0 1 .2.2V6Z"/></svg>`,
  tag: `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M3 11.2V4a1 1 0 0 1 1-1h7.2a1 1 0 0 1 .7.29l8.81 8.81a1 1 0 0 1 0 1.41l-7.01 7.01a1 1 0 0 1-1.41 0L3.29 11.9A1 1 0 0 1 3 11.2ZM7 6a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z"/></svg>`,
  back: `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M11.67 4.6 4.27 12l7.4 7.4 1.42-1.42L8.11 13H20v-2H8.1l4.99-4.99-1.42-1.42Z"/></svg>`,
  library: `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M6 3.5A2.5 2.5 0 0 1 8.5 1H20v20H8.5A3.5 3.5 0 0 0 6 22V3.5Zm2.5-.5A1.5 1.5 0 0 0 7 4.5v14.8c.44-.2.93-.3 1.5-.3H18V3H8.5Z"/></svg>`,
  filter: `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v.2a1.5 1.5 0 0 1-.44 1.06L14 13.35V18a1 1 0 0 1-.45.83l-2 1.3A1 1 0 0 1 10 19.3v-5.95L4.44 7.78A1.5 1.5 0 0 1 4 6.72v-.22Z"/></svg>`,
  check: `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="m9.1 16.2-4.3-4.3 1.4-1.4 2.9 2.9 8.7-8.7 1.4 1.4-10.1 10.1Z"/></svg>`,
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
        if (modalOpen) {
          this.closeModal();
        } else {
          this.close();
        }
        return;
      }
      if (modalOpen) return;

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
        const active = document.activeElement as HTMLElement | null;
        if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT') && !active.classList.contains('search-input')) {
          return;
        }
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
      setTimeout(() => input.focus(), 10);
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

    const width = Math.min(mobile ? viewportWidth - margin * 2 : 440, viewportWidth - margin * 2);
    const height = Math.min(mobile ? viewportHeight - 96 : 520, viewportHeight - margin * 2);

    if (picker) {
      picker.style.width = `${Math.max(280, width)}px`;
      picker.style.height = `${Math.max(220, height)}px`;
      picker.style.maxHeight = `${Math.max(220, height)}px`;
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
    const footerHeight = footer
      ? getComputedStyle(footer).position === 'absolute'
        ? 76
        : footer.offsetHeight
      : 0;

    const firstItem = list.querySelector('.item') as HTMLElement | null;
    const itemSpacing = firstItem
      ? (firstItem.offsetHeight + (parseFloat(getComputedStyle(firstItem).marginBottom) || 0))
      : 96;

    const visibleRows = itemCount <= 0 ? 1 : 2.5;
    const listTarget = itemCount <= 0 ? 104 : Math.max(228, itemSpacing * visibleRows + 8);
    const viewportMax = Math.min(window.innerHeight - 24, 620);
    const viewportMin = headerHeight + footerHeight + 104;
    const target = Math.max(viewportMin, Math.min(headerHeight + footerHeight + listTarget, viewportMax));

    picker.style.height = `${Math.round(target)}px`;
    picker.style.maxHeight = `${Math.round(viewportMax)}px`;
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
      @import url('https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,400;500;600&family=Noto+Serif+SC:wght@400;500;600;700&display=swap');
      @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');
      @font-face {
        font-family: 'GP Styrene';
        src: local('Styrene A'), local('Styrene B'), local('Styrene A Web'), local('Styrene B Web'), local('Styrene');
        font-weight: 100 900;
        font-style: normal;
        font-display: swap;
      }
      @font-face {
        font-family: 'GP Tiempos';
        src: local('Tiempos Text'), local('Tiempos Headline'), local('Tiempos');
        font-weight: 100 900;
        font-style: normal;
        font-display: swap;
      }
      @font-face {
        font-family: 'Anthropic Serif Web Text';
        src: local('Anthropic Serif Web Text'), local('Anthropic Serif Text'), local('Anthropic Serif');
        font-weight: 100 900;
        font-style: normal;
        font-display: swap;
      }

      :host {
        /* Core Palette - Strictly defined, no OS overrides */
        --gp-font-sans: 'GP Styrene', 'Styrene A', 'Styrene B', 'Styrene', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        --gp-font-serif: 'GP Tiempos', 'Tiempos Text', 'Tiempos Headline', 'Tiempos', 'Anthropic Serif Web Text', 'Anthropic Serif Text', 'Anthropic Serif', 'Source Serif 4', 'Noto Serif SC', 'Songti SC', 'SimSun', 'Georgia', serif; 
        
        /* Anthropic-inspired palette */
        --gp-surface: #ede9e0;
        --gp-surface-elevated: #f5f2ea;
        --gp-ink: #1b1a18;
        --gp-stone: #a4a19b;
        --gp-slate: #5b5954;
        --gp-muted: #838079;
        --gp-coral: #d97c5d;

        /* Light Mode Defaults */
        --gp-bg-glass: rgba(237, 233, 224, 0.94);
        --gp-fg: var(--gp-ink);
        --gp-fg-secondary: var(--gp-slate);
        --gp-fg-tertiary: var(--gp-muted);
        --gp-border: rgba(91, 89, 84, 0.24);
        --gp-bg-hover: rgba(91, 89, 84, 0.08);
        --gp-bg-active: rgba(91, 89, 84, 0.14);
        --gp-shadow-sm: 0 4px 12px rgba(27, 26, 24, 0.08);
        --gp-shadow-lg: 0 24px 48px -14px rgba(27, 26, 24, 0.22), 0 0 1px rgba(27, 26, 24, 0.18);
        --gp-danger: #b85a3e;
        --gp-accent: var(--gp-ink);
        --gp-accent-fg: var(--gp-surface);
        --gp-focus: var(--gp-coral);
        --gp-radius-lg: 16px;
        --gp-radius-md: 10px;
        --gp-radius-sm: 6px;
      }

      /* Dark Mode - Explicit Data Attribute Strategy */
      :host([data-gp-theme="dark"]) {
        --gp-bg-glass: rgba(27, 26, 24, 0.94);
        --gp-fg: #ede9e0;
        --gp-fg-secondary: #c9c5bc;
        --gp-fg-tertiary: #a4a19b;
        --gp-border: rgba(237, 233, 224, 0.16);
        --gp-bg-hover: rgba(237, 233, 224, 0.08);
        --gp-bg-active: rgba(237, 233, 224, 0.14);
        --gp-shadow-sm: 0 4px 12px rgba(0, 0, 0, 0.32);
        --gp-shadow-lg: 0 26px 52px -12px rgba(0, 0, 0, 0.52), 0 0 1px rgba(237, 233, 224, 0.2);
        --gp-danger: #ff8b67;
        --gp-accent: #ede9e0;
        --gp-accent-fg: #1b1a18;
        --gp-focus: #d97c5d;
      }

      * { box-sizing: border-box; outline: none; }

      /* === MAIN CONTAINER === */
      .picker {
        position: relative;
        width: 400px; /* Slightly wider for breathing room */
        max-height: 600px;
        background: var(--gp-bg-glass);
        backdrop-filter: blur(24px) saturate(180%);
        -webkit-backdrop-filter: blur(24px) saturate(180%);
        border: 1px solid var(--gp-border);
        border-radius: var(--gp-radius-lg);
        box-shadow: var(--gp-shadow-lg);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        font-family: var(--gp-font-sans);
        color: var(--gp-fg);
        z-index: 99999;
        
        /* Animation States */
        opacity: 0;
        transform: translateY(12px) scale(0.96);
        transition: opacity 0.25s cubic-bezier(0.16, 1, 0.3, 1), 
                    transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
        pointer-events: none;
      }

      .picker.open {
        opacity: 1;
        transform: translateY(0) scale(1);
        pointer-events: auto;
      }

      /* === HEADER === */
      .header {
        padding: 16px 16px 8px; /* Breathing room */
        flex-shrink: 0;
      }

      .search-row {
        position: relative;
        background: rgba(91, 89, 84, 0.09);
        border-radius: 99px;
        transition: box-shadow 0.2s, background 0.2s;
        border: 1px solid transparent;
      }
      .search-row:focus-within {
        background: var(--gp-surface-elevated);
        box-shadow: 0 0 0 2px var(--gp-focus);
      }

      .search-box {
        display: flex;
        align-items: center;
        height: 38px;
        padding: 0 12px;
      }

      .search-icon {
        color: var(--gp-fg-secondary);
        opacity: 0.7;
        margin-right: 8px;
        display: flex; /* Fix icon alignment */
      }

      .search-input {
        flex: 1;
        background: transparent;
        border: none;
        color: var(--gp-fg);
        font-family: var(--gp-font-sans); /* Use Sans for inputs */
        font-size: 14px;
        font-weight: 500;
        padding: 0;
      }
      .search-input::placeholder {
        color: var(--gp-fg-tertiary);
        font-weight: 400;
      }

      /* === TAGS AREA === */
      .tags-area {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        padding: 12px 16px 4px;
        margin: 0; /* Reset margins */
      }
      .tag {
        font-family: var(--gp-font-sans);
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.01em;
        background: var(--gp-bg-hover);
        color: var(--gp-fg-secondary);
        padding: 4px 10px;
        border-radius: 99px;
        border: 1px solid transparent; /* Prepare for border transition */
        transition: all 0.15s ease;
      }
      .tag:hover {
        background: var(--gp-bg-active);
        transform: translateY(-1px);
        color: var(--gp-fg);
      }
      .tag.active {
        background: var(--gp-accent);
        color: var(--gp-accent-fg);
        box-shadow: 0 2px 8px rgba(0,0,0,0.15);
      }

      /* === LIST === */
      .list {
        flex: 1;
        overflow-y: auto;
        overscroll-behavior: contain;
        padding: 8px 12px 84px;
      }
      .list::-webkit-scrollbar {
        width: 8px;
      }
      .list::-webkit-scrollbar-thumb {
        background: rgba(131, 128, 121, 0.7);
        border-radius: 999px;
      }
      
      .empty-box {
        margin-top: 60px;
        display: flex;
        flex-direction: column;
        align-items: center;
        text-align: center;
        gap: 12px;
        color: var(--gp-fg-tertiary);
        opacity: 0.8;
      }
      .empty-box::before {
        content: 'No prompts';
        font-family: var(--gp-font-serif);
        font-size: 20px;
        font-weight: 500;
        color: var(--gp-fg-secondary);
      }

      /* === LIST ITEM === */
      .item {
        position: relative;
        padding: 14px 16px;
        margin-bottom: 4px;
        border-radius: var(--gp-radius-md);
        cursor: pointer;
        border: 1px solid transparent;
        transition: transform 0.16s cubic-bezier(0.16, 1, 0.3, 1), background 0.16s ease, border-color 0.16s ease;
      }
      .item::before {
        content: '';
        position: absolute;
        left: 0;
        top: 10px;
        bottom: 10px;
        width: 3px;
        border-radius: 0 4px 4px 0;
        background: var(--gp-accent);
        opacity: 0;
        transform: scaleY(0.65);
        transform-origin: center;
        transition: opacity 0.16s ease, transform 0.16s ease;
      }
      .item:hover {
        background: transparent;
        border-color: transparent;
        transform: translateX(3px);
      }
      .item.selected {
        background: transparent;
        border-color: transparent;
        transform: translateX(2px);
      }
      .item:hover::before,
      .item.selected::before {
        opacity: 1;
        transform: scaleY(1);
      }
      .item-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 4px;
        padding-right: 60px; /* Space for actions */
      }

      .item-title {
        font-family: var(--gp-font-serif);
        font-size: 16px;
        font-weight: 600;
        color: var(--gp-fg);
        line-height: 1.4;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .item-preview {
        font-family: var(--gp-font-sans);
        font-size: 13px;
        color: var(--gp-fg-secondary);
        line-height: 1.5;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .item-content {
        min-width: 0;
        padding-right: 88px;
      }
      .item-head {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 4px;
      }

      /* === ITEM ACTIONS === */
      .item-actions {
        position: absolute;
        top: 12px;
        right: 12px;
        display: flex;
        gap: 4px;
        opacity: 0;
        transform: translateX(10px);
        transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
        z-index: 10;
        /* No background! */
      }
      
      .item:hover .item-actions,
      .item.selected .item-actions,
      .item.editing .item-actions {
        opacity: 1;
        transform: translateX(0);
      }

      .item-action-btn {
        width: 32px;
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 8px;
        border: none;
        background: var(--gp-surface-elevated);
        backdrop-filter: blur(4px);
        box-shadow: 0 2px 8px rgba(27, 26, 24, 0.12);
        color: var(--gp-fg-secondary);
        cursor: pointer;
        transition: all 0.15s;
        padding: 0;
      }
      .item-action-btn:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 12px rgba(27, 26, 24, 0.18);
        color: var(--gp-fg);
        background: var(--gp-surface);
      }
      .item-action-btn.danger:hover {
        color: var(--gp-danger);
      }

      /* Delete Confirmation Inline */
      .delete-inline {
        display: flex;
        gap: 8px;
        align-items: center;
        background: rgba(131, 128, 121, 0.18);
        padding: 4px 6px;
        border-radius: 10px;
        box-shadow: var(--gp-shadow-sm);
        animation: slideIn 0.14s ease-out forwards;
      }
      @keyframes slideIn { from { opacity: 0; transform: translateX(10px); } to { opacity: 1; transform: translateX(0); } }

      .delete-inline-btn {
        height: 28px;
        padding: 0 12px;
        border-radius: 6px;
        border: none;
        font-family: var(--gp-font-sans);
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: 4px;
        color: var(--gp-fg);
        background: transparent;
      }
      .delete-inline-btn.confirm {
        background: var(--gp-danger);
        color: white;
        box-shadow: 0 2px 4px rgba(217, 48, 37, 0.3);
      }
      .delete-inline-btn.confirm:hover { box-shadow: 0 3px 8px rgba(217, 48, 37, 0.4); transform: translateY(-1px); }
      .delete-inline-btn:hover {
        background: var(--gp-bg-hover);
      }

      /* === INLINE EDITOR === */
      .inline-editor {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .inline-editor-row {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .inline-editor-label {
        font-family: var(--gp-font-sans);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--gp-fg-secondary);
      }
      .inline-editor-input,
      .inline-editor-textarea {
        width: 100%;
        border: 1px solid var(--gp-border);
        border-radius: 10px;
        background: var(--gp-bg-hover);
        color: var(--gp-fg);
        font-family: var(--gp-font-sans);
        font-size: 13px;
        padding: 10px 12px;
      }
      .inline-editor-input:focus,
      .inline-editor-textarea:focus {
        border-color: rgba(217, 124, 93, 0.7);
        background: rgba(237, 233, 224, 0.78);
      }
      .inline-editor-textarea {
        min-height: 108px;
        line-height: 1.45;
        resize: vertical;
        max-height: 260px;
      }
      .inline-editor-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
      .inline-editor-btn {
        height: 32px;
        border-radius: 999px;
        border: 1px solid var(--gp-border);
        background: transparent;
        color: var(--gp-fg);
        font-family: var(--gp-font-sans);
        font-size: 13px;
        padding: 0 14px;
        cursor: pointer;
      }
      .inline-editor-btn:hover {
        background: var(--gp-bg-hover);
      }
      .inline-editor-btn.primary {
        border: none;
        background: var(--gp-accent);
        color: var(--gp-accent-fg);
      }

      /* === FLOATING ACTION === */
      .footer-action {
        position: absolute;
        right: 12px;
        bottom: 12px;
        z-index: 8;
        pointer-events: none;
      }
      .footer-buttons {
        display: flex;
        align-items: center;
        gap: 8px;
        pointer-events: auto;
      }
      .btn-utility {
        height: 36px;
        border-radius: 999px;
        border: 1px solid var(--gp-border);
        background: var(--gp-bg-glass);
        color: var(--gp-fg);
        font-family: var(--gp-font-sans);
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.01em;
        padding: 0 12px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        box-shadow: var(--gp-shadow-sm);
        transition: background 0.15s ease, transform 0.15s ease;
      }
      .btn-utility:hover {
        background: var(--gp-bg-hover);
        transform: translateY(-1px);
      }
      .btn-new {
        width: 40px;
        height: 40px;
        border-radius: 50%;
        background: var(--gp-accent);
        color: var(--gp-accent-fg);
        border: none;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        pointer-events: auto;
        box-shadow: 0 10px 20px -12px rgba(27, 26, 24, 0.45);
        transition: transform 0.15s ease, filter 0.15s ease;
      }
      .btn-new:hover {
        transform: translateY(-1px);
        filter: brightness(1.03);
      }
      .btn-new:active { transform: scale(0.96); }
      .btn-new span {
        display: none;
      }
      .btn-new svg { width: 16px; height: 16px; }

      /* === MODAL (EDIT/CREATE) === */
      .modal-overlay {
        position: fixed;
        inset: 0;
        background: rgba(27, 26, 24, 0.26);
        z-index: 2147483647;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
        animation: modalFadeIn 0.25s ease-out;
      }
      @keyframes modalFadeIn { from { opacity: 0; transform: scale(0.98); } to { opacity: 1; transform: scale(1); } }
      .modal {
        width: min(860px, calc(100vw - 32px));
        height: min(66vh, 580px);
        min-height: min(410px, calc(100vh - 32px));
        background: rgba(245, 242, 234, 0.98);
        border: 1px solid var(--gp-border);
        border-radius: 12px;
        box-shadow: 0 12px 28px rgba(27, 26, 24, 0.2);
        overflow: hidden;
        display: flex;
        flex-direction: column;
      }
      :host([data-gp-theme="dark"]) .modal {
        background: rgba(35, 33, 30, 0.98);
        border-color: var(--gp-border);
        box-shadow: 0 12px 28px rgba(0, 0, 0, 0.45);
      }

      .modal-header {
        padding: 6px 14px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        border-bottom: 1px solid var(--gp-border);
      }
      :host([data-gp-theme="dark"]) .modal-header {
        border-bottom-color: var(--gp-border);
      }
      .modal-title {
        font-family: var(--gp-font-serif);
        font-size: 16px;
        font-weight: 600;
        color: var(--gp-fg);
      }
      .modal-close {
        background: transparent;
        border: none;
        color: var(--gp-fg-secondary);
        cursor: pointer;
        padding: 4px;
        border-radius: 6px;
        transition: background 0.15s ease;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .modal-close:hover { background: var(--gp-bg-hover); color: var(--gp-fg); }

      .modal-body {
        padding: 10px 14px 10px;
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      /* Form Elements */
      .form-group { display: flex; flex-direction: column; gap: 10px; }
      .form-group.content-group { flex: 1; min-height: 150px; }
      .form-label {
        font-size: 12px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.045em;
        color: var(--gp-fg-secondary);
        font-family: var(--gp-font-sans);
      }

      .form-input, .form-textarea {
        background: rgba(237, 233, 224, 0.88);
        border: 1px solid var(--gp-border);
        border-radius: 8px;
        padding: 11px 14px;
        font-size: 16px;
        color: var(--gp-fg);
        width: 100%;
        transition: border-color 0.15s ease, box-shadow 0.15s ease;
      }
      .form-input {
        font-family: var(--gp-font-serif);
        font-weight: 500;
      }
      .form-textarea {
        font-family: var(--gp-font-serif);
      }
      :host([data-gp-theme="dark"]) .form-input,
      :host([data-gp-theme="dark"]) .form-textarea {
        background: rgba(28, 28, 28, 0.92);
        border-color: rgba(255, 255, 255, 0.15);
      }
      .form-input:focus, .form-textarea:focus {
        border-color: rgba(217, 124, 93, 0.7);
        box-shadow: none;
        outline: none;
      }
      .form-input::placeholder, .form-textarea::placeholder {
        color: var(--gp-fg-tertiary);
        font-style: normal;
      }
      .form-input {
        border-color: rgba(91, 89, 84, 0.18);
      }
      .form-textarea {
        border-color: rgba(91, 89, 84, 0.3);
      }
      .form-textarea {
        flex: 1;
        min-height: 160px;
        height: 100%;
        resize: none;
        line-height: 1.55;
        padding-bottom: 34px;
      }
      .textarea-shell {
        position: relative;
        flex: 1;
        min-height: 0;
      }
      .textarea-token {
        position: absolute;
        right: 12px;
        bottom: 12px;
        font-family: var(--gp-font-sans);
        font-size: 12px;
        line-height: 1;
        color: var(--gp-fg-secondary);
        pointer-events: none;
        user-select: none;
      }

      .modal-footer {
        padding: 8px 14px 10px;
        border-top: 1px solid var(--gp-border);
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        flex-shrink: 0;
        background: transparent;
      }
      :host([data-gp-theme="dark"]) .modal-footer {
        border-top-color: var(--gp-border);
      }
      .modal-footer-left,
      .modal-footer-right {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .modal-footer-right {
        margin-left: auto;
      }

      .btn {
        height: 36px;
        padding: 0 14px;
        border-radius: 6px;
        font-family: var(--gp-font-sans);
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
      }
      .btn-cancel {
        background: rgba(91, 89, 84, 0.06);
        border: 1px solid rgba(91, 89, 84, 0.28);
        color: var(--gp-fg);
      }
      .btn-cancel:hover {
        background: rgba(91, 89, 84, 0.12);
        border-color: rgba(91, 89, 84, 0.4);
      }

      .btn-delete {
        border: 1px solid transparent;
        color: rgba(190, 24, 24, 0.8);
        background: transparent;
        font-weight: 500;
      }
      .btn-delete:hover {
        background: rgba(217, 48, 37, 0.06);
        border-color: rgba(217, 48, 37, 0.24);
      }
      .btn-delete.confirming {
        background: rgba(217, 48, 37, 0.1);
        color: #b42318;
        border-color: rgba(217, 48, 37, 0.4);
      }
      
      .btn-save {
        background: var(--gp-accent);
        color: var(--gp-accent-fg);
        border: 1px solid var(--gp-accent);
      }
      .btn-save:hover { filter: brightness(1.06); }
      .btn-save:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }
    `;
  }

  private render() {
    this.shadow.innerHTML = `
      <style>${this.getStyles()}</style>
      <div class="picker">
        <div class="header">
          <div class="search-row">
            <div class="search-box">
              <span class="search-icon">${ICONS.search}</span>
              <input class="search-input" type="text" placeholder="Search prompts..." />
            </div>
          </div>
        </div>
        <div class="list" id="list-container"></div>
        <div class="footer-action">
          <div class="footer-buttons">
            <button class="btn-utility" id="btn-backup" title="Backup to local file">Backup</button>
            <button class="btn-utility" id="btn-restore" title="Restore from backup file">Restore</button>
            <button class="btn-new" id="btn-primary-action" title="New Prompt">
              ${ICONS.plus} <span>New Prompt</span>
            </button>
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
    this.shadow.getElementById('btn-backup')?.addEventListener('click', async () => {
      try {
        await exportAllData();
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error('[GP Prompts] Backup failed', error);
        alert('Backup failed. Please try again.');
      }
    });
    this.shadow.getElementById('btn-restore')?.addEventListener('click', () => {
      triggerImport(async (result) => {
        alert(result.message);
        if (!result.success) return;

        try {
          await this.sendRuntimeMessage({ type: 'refreshStateCache' });
        } catch {
          // ignore and continue with page reload
        }
        window.location.reload();
      });
    });
    this.refreshPickerControls();
  }

  private async sendRuntimeMessage<T>(message: T): Promise<void> {
    const response = await runtimeSendMessage<{ ok?: boolean; error?: string }>(message);
    if (response && response.ok === false) {
      throw new Error(response.error || 'Runtime message failed');
    }
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
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h2 class="modal-title">${prompt ? 'Edit Prompt' : 'New Prompt'}</h2>
          <button class="modal-close" id="modal-close">${ICONS.close}</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Name</label>
            <input class="form-input" id="prompt-title" type="text" placeholder="e.g. Code Review" value="${safeTitle}" />
          </div>
          <div class="form-group content-group">
            <label class="form-label">Prompt Content</label>
            <div class="textarea-shell">
              <textarea class="form-textarea" id="prompt-content" placeholder="Enter your prompt template...">${safeContent}</textarea>
              <span class="textarea-token" id="content-token-estimate">~0 tokens</span>
            </div>
          </div>
        </div>
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

    await promptStore.save(promptData);
    this.closeModal();
    this.updateList();
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
    if (this.pendingDeletePromptId && !this.visiblePromptIds.includes(this.pendingDeletePromptId)) {
      this.pendingDeletePromptId = null;
    }

    if (displayPrompts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-box';
      empty.textContent = 'No prompts found';
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
      preview.textContent = prompt.content.replace(/\s+/g, ' ').trim().slice(0, 60);
      content.appendChild(head);
      content.appendChild(preview);

      item.appendChild(content);
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
      item.addEventListener('mousemove', () => {
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




