import { ChatRef, Project, ProjectIcon, RuntimeState } from '../../shared/types';
import { ICON_OPTIONS, COLOR_OPTIONS, getIconLabel, renderIconSvg } from './icons';

interface ProjectsPanelOptions {
  shadow: ShadowRoot;
  overlayShadow: ShadowRoot;
  onSaveProject: (project: Project) => void;
  onToggleProjectExpand: (projectId: string) => void;
  onDeleteProject: (projectId: string) => void;
  onToggleCollapse: (collapsed: boolean) => void;
  onRemoveChatFromProject: (conversationId: string) => void;
  onMoveChatToProject: (conversationId: string, projectId: string) => void;
}

type ModalMode = 'create' | 'edit';

export function createProjectsPanel(options: ProjectsPanelOptions) {
  const panelRoot = ensurePanelRoot(options.shadow);
  const overlayLayer = ensureOverlayLayer(options.overlayShadow);
  const modal = createModal(overlayLayer);
  const projectMenu = createProjectMenu(overlayLayer);
  const toast = createToast(overlayLayer);

  // Initialize theme observer
  attachThemeObserver(panelRoot, overlayLayer);

  // 用于存储当前 state 以供 chatMenu 获取项目列表
  let currentState: RuntimeState | null = null;
  const chatMenu = createChatMenu(overlayLayer, () => currentState?.projects || []);

  let modalMode: ModalMode = 'create';
  let modalProjectId: string | null = null;
  let modalProject: Project | null = null;
  let modalSelectedIcon: ProjectIcon = 'default';
  let modalSelectedColor: string = '#1f1f1f'; // Default black
  let inputDirty = false;
  let iconButton: HTMLButtonElement | null = null;
  let iconPopover: HTMLElement | null = null;

  function render(state: RuntimeState) {
    // 存储当前 state 以供 chatMenu 获取项目列表
    currentState = state;
    // Render markup based on uiPrefs (collapsed state)
    panelRoot.innerHTML = buildPanelMarkup(state);
    attachPanelEvents(state);
  }

  function attachPanelEvents(state: RuntimeState) {
    const header = panelRoot.querySelector<HTMLElement>('[data-gp-action="toggle-section"]');
    const newProjectRow = panelRoot.querySelector<HTMLElement>('[data-gp-action="new-project"]');

    // Header click toggles collapse state
    header?.addEventListener('click', (e) => {
      // Prevent toggling if user clicked a button inside header (if any)
      if ((e.target as HTMLElement).closest('button')) return;
      const isCollapsed = state.uiPrefs.projectsCollapsed;
      options.onToggleCollapse(!isCollapsed);
    });

    newProjectRow?.addEventListener('click', () => openCreateModal());

    panelRoot.querySelectorAll<HTMLElement>('[data-gp-project-id]').forEach((row) => {
      const projectId = row.dataset.gpProjectId as string;
      const kebab = row.querySelector<HTMLButtonElement>('[data-gp-action="project-menu"]');
      const toggleRow = row.querySelector<HTMLElement>('[data-gp-action="toggle-project"]');

      toggleRow?.addEventListener('click', (event) => {
        if ((event.target as HTMLElement).closest('[data-gp-action="project-menu"]')) {
          return;
        }
        options.onToggleProjectExpand(projectId);
      });

      kebab?.addEventListener('click', (event) => {
        event.stopPropagation();
        const project = state.projects.find((item) => item.id === projectId);
        if (project) {
          openProjectMenu(project, kebab.getBoundingClientRect());
        }
      });

      // Chat kebab 菜单处理 (Chat row context menu)
      const chatKebabs = row.querySelectorAll<HTMLButtonElement>('[data-gp-action="chat-menu"]');
      chatKebabs.forEach((chatKebab) => {
        const chatRow = chatKebab.closest<HTMLElement>('[data-gp-chat-id]');
        if (!chatRow) return;

        const chatId = chatRow.dataset.gpChatId as string;
        const chatProjectId = chatRow.dataset.gpProjectId as string;
        const chatLink = chatRow.querySelector<HTMLAnchorElement>('.gp-chat-link');

        // Route via Gemini's native sidebar link first to preserve SPA navigation behavior.
        chatLink?.addEventListener('click', (event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
            return;
          }
          event.preventDefault();
          navigateToChatViaNativeLink(chatId, chatLink.href);
        });

        chatKebab.addEventListener('click', (event) => {
          event.stopPropagation();
          event.preventDefault();
          const project = state.projects.find((p) => p.id === chatProjectId);
          if (project) {
            chatMenu.open(
              chatKebab.getBoundingClientRect(),
              chatId,
              chatProjectId,
              project.name,
              {
                onRemove: () => options.onRemoveChatFromProject(chatId),
                onMoveToProject: (targetProjectId) => options.onMoveChatToProject(chatId, targetProjectId)
              }
            );
          }
        });
      });
    });
  }

  function openCreateModal() {
    modalMode = 'create';
    modalProjectId = null;
    modalSelectedIcon = 'default';
    showModal({
      title: 'Create Project',
      confirmLabel: 'Create Project',
      name: '',
      showIcons: true
    });
  }

  function openEditModal(project: Project) {
    modalMode = 'edit';
    modalProjectId = project.id;
    modalProject = project;
    modalSelectedIcon = project.icon;
    modalSelectedColor = project.color || '#1f1f1f';
    showModal({
      title: 'Edit project',
      confirmLabel: 'Save',
      name: project.name,
      showIcons: true
    });
  }

  function updateIconButton() {
    if (iconButton) {
      // Use currentColor (undefined) for Black option to adapt to theme
      const color = modalSelectedColor === '#1f1f1f' ? undefined : modalSelectedColor;
      iconButton.innerHTML = renderIconSvg(modalSelectedIcon, color);
    }
  }

  function createProjectFromTemplate(
    templateName: string,
    templateIcon: ProjectIcon,
    input?: HTMLInputElement,
    confirm?: HTMLButtonElement
  ) {
    modalSelectedIcon = templateIcon;
    updateIconButton();
    if (!inputDirty && input) {
      input.value = templateName;
    }
    if (confirm && input) {
      confirm.disabled = input.value.trim().length === 0;
    }
  }

  function showModal(config: { title: string; confirmLabel: string; name: string; showIcons: boolean }) {
    modal.open(config);
    inputDirty = false;
    const input = modal.element.querySelector<HTMLInputElement>('[data-gp-name-input]');
    const confirm = modal.element.querySelector<HTMLButtonElement>('[data-gp-action="confirm"]');
    const iconRow = modal.element.querySelector<HTMLElement>('[data-gp-template-row]');
    iconButton = modal.element.querySelector<HTMLButtonElement>('[data-gp-action="icon-picker"]');
    iconPopover = modal.element.querySelector<HTMLElement>('[data-gp-icon-popover]');

    if (input) {
      input.value = config.name;
      input.focus();
    }

    if (iconRow) {
      iconRow.style.display = config.showIcons ? 'flex' : 'none';
    }

    confirm!.textContent = config.confirmLabel;
    confirm!.disabled = input?.value.trim().length === 0;
    updateIconButton();

    if (input) {
      input.oninput = () => {
        inputDirty = true;
        confirm!.disabled = input.value.trim().length === 0;
      };
    }

    confirm!.onclick = () => {
      const name = input?.value.trim() ?? '';
      if (!name) {
        return;
      }

      const now = Date.now();
      const projectData: Project = {
        id: modalMode === 'create' ? crypto.randomUUID() : (modalProjectId!),
        name,
        icon: modalSelectedIcon,
        color: modalSelectedColor,
        createdAt: modalMode === 'create' ? now : (modalProject?.createdAt || now),
        updatedAt: now,
        sortIndex: modalMode === 'create' ? now : (modalProject?.sortIndex || now)
      };

      options.onSaveProject(projectData);
      modal.close();
    };

    if (iconButton) {
      iconButton.onclick = (event) => {
        event.stopPropagation();
        if (!iconPopover) return;
        iconPopover.style.display = iconPopover.style.display === 'flex' ? 'none' : 'flex';
      };
    }

    modal.element.onclick = (event) => {
      const target = event.target as HTMLElement;
      if (!iconPopover || !iconButton) return;
      if (iconPopover.contains(target) || iconButton.contains(target)) {
        return;
      }
      iconPopover.style.display = 'none';
    };

    iconPopover?.querySelectorAll<HTMLElement>('[data-gp-icon-option]').forEach((option) => {
      option.onclick = () => {
        const iconId = option.dataset.gpIconOption as ProjectIcon;
        modalSelectedIcon = iconId;
        updateIconButton();
        if (iconPopover) {
          iconPopover.style.display = 'none';
        }
      };
    });

    iconRow?.querySelectorAll<HTMLElement>('[data-gp-template]').forEach((chip) => {
      chip.onclick = () => {
        const iconId = chip.dataset.gpTemplate as ProjectIcon;
        const label = chip.dataset.gpTemplateLabel || getIconLabel(iconId);
        createProjectFromTemplate(label, iconId, input ?? undefined, confirm ?? undefined);
      };
    });

    // Color picker click handlers
    const colorRow = modal.element.querySelector<HTMLElement>('[data-gp-color-row]');
    colorRow?.querySelectorAll<HTMLButtonElement>('[data-gp-color]').forEach((dot) => {
      dot.onclick = () => {
        const color = dot.dataset.gpColor;
        if (color) {
          modalSelectedColor = color;
          // Update visual selection
          colorRow.querySelectorAll('.gp-color-dot').forEach(d => d.classList.remove('selected'));
          dot.classList.add('selected');
          // Update icon color in real-time
          updateIconButton();
        }
      };
    });
  }

  function openProjectMenu(project: Project, anchorRect: DOMRect) {
    projectMenu.open(anchorRect, project, {
      onEdit: () => openEditModal(project),
      onDelete: () => options.onDeleteProject(project.id)
    });
  }

  function showToast(message: string) {
    toast.show(message);
  }

  function closeAllOverlays() {
    modal.close();
    projectMenu.close();
    toast.hide();
  }

  return {
    render,
    closeAllOverlays,
    showToast,
    openCreateModal
  };
}

export function renderProjectsSection(
  projects: Project[],
  chatIndex: Map<string, ChatRef>,
  expandedProjectIds: Set<string>
): string {
  const sorted = [...projects].sort((a, b) => a.sortIndex - b.sortIndex);
  if (!sorted.length) {
    return ''; // No placeholder when empty, cleaner look
  }

  return sorted
    .map((project) => {
      const isExpanded = expandedProjectIds.has(project.id);
      const chats = Array.from(chatIndex.values())
        .filter((chat) => chat.projectId === project.id)
        .sort((a, b) => b.updatedAt - a.updatedAt);

      const chatRows = isExpanded
        ? `
          <div class="gp-project-chats">
            ${chats.length
          ? chats
            .map(
              (chat) => `
                        <div class="gp-chat-row" data-gp-chat-id="${chat.conversationId}" data-gp-project-id="${project.id}">
                          <a class="gp-chat-link" href="${escapeHtml(chat.lastUrl || `/app/${chat.conversationId}`)}">
                            <span class="gp-chat-title">${escapeHtml(chat.title || 'Untitled chat')}</span>
                          </a>
                          <button class="gp-chat-kebab" data-gp-action="chat-menu" aria-label="Chat menu"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="12" cy="4" r="2.5"/><circle cx="12" cy="12" r="2.5"/><circle cx="12" cy="20" r="2.5"/></svg></button>
                        </div>
                      `
            )
            .join('')
          : '<div class="gp-chat-empty">No chats yet</div>'
        }
          </div>
        `
        : '';

      return `
        <div class="gp-project" data-gp-project-id="${project.id}">
          <div class="gp-row gp-project-row ${isExpanded ? 'active' : ''}" data-gp-action="toggle-project">
            <span class="gp-icon">${renderIconSvg(project.icon, project.color)}</span>
            <span class="gp-label">${escapeHtml(project.name)}</span>
            <button class="gp-kebab" data-gp-action="project-menu" aria-label="Project menu"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg></button>
          </div>
          ${chatRows}
        </div>
      `;
    })
    .join('');
}

function ensurePanelRoot(shadow: ShadowRoot): HTMLElement {
  let root = shadow.getElementById('gp-panel-root') as HTMLElement | null;
  if (!root) {
    root = document.createElement('div');
    root.id = 'gp-panel-root';
    shadow.appendChild(root);
  }
  if (!shadow.querySelector('style[data-gp="panel"]')) {
    const style = document.createElement('style');
    style.dataset.gp = 'panel';
    style.textContent = `
      :host {
        all: initial;
        font-family: inherit;
        color: var(--gp-fg, #1f1f1f);
        box-sizing: border-box;
        
        /* Native Fonts & Colors (Gemini) */
        --gp-font: "Google Sans Flex", "Google Sans", "Helvetica Neue", sans-serif;
        --gp-fg: #1f1f1f;
        --gp-fg-muted: #444746;
        --gp-bg-hover: rgba(68, 71, 70, 0.08); 
        --gp-bg-active: rgba(68, 71, 70, 0.12);
        
        --gp-radius: 24px;
        --gp-spacing-row: 0px;
        
        display: block;
        padding-top: 12px;
      }
      
      :host(.dark) {
        --gp-fg: #e3e3e3;
        --gp-fg-muted: #c4c7c5;
        --gp-bg-hover: rgba(255, 255, 255, 0.08); 
        --gp-bg-active: rgba(255, 255, 255, 0.12);
      }

      * {
        box-sizing: border-box;
      }

      .gp-panel {
        display: flex;
        flex-direction: column;
        gap: var(--gp-spacing-row);
        background: transparent;
        padding: 0;
      }

      /* GPT-Style Header (Projects v) */
      .gp-title {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: 2px; /* Close gap */
        
        margin: 0;
        /* Reverted to 12px as 16px was "Too Right" */
        padding: 0 12px; 
        
        height: 44px;
        color: var(--gp-fg); 
        font-family: var(--gp-font);
        font-size: 14px;
        font-weight: 500;
        line-height: 20px;
        cursor: pointer;
        user-select: none;
        border-radius: var(--gp-radius);
        transition: background 0.1s ease;
      }
      
      .gp-title:hover {
        background: var(--gp-bg-hover);
      }

      .gp-chevron {
        width: 20px;
        height: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: transform 0.2s cubic-bezier(0.2, 0, 0, 1);
        color: var(--gp-fg-muted);
        opacity: 0.6;
      }
      
      .gp-chevron svg {
        width: 18px; 
        height: 18px;
        /* Rounded Stroke Style */
        fill: none;
      }

      /* When collapsed, arrow points right (like text flow) 
         or logic: Collapsed = Arrow Right ( > ), Expanded = Arrow Down ( v )
         Currently: Expanded by default.
         If default Markup has arrow pointing down:
      */
      .gp-title.collapsed .gp-chevron {
        transform: rotate(-90deg); /* Points Right */
      }

      .gp-list-container {
        display: flex;
        flex-direction: column;
        gap: 0; /* Tightest packing */
        overflow: hidden;
        padding-top: 2px; /* Space between header and list */
      }
      
      .gp-list-container.hidden {
        display: none;
      }

      /* Standard Row (Floating Pill style) */
      .gp-row {
        display: flex;
        align-items: center;
        gap: 12px;
        
        /* Removed margin to align text with Gems */
        margin: 0;
        padding: 0 16px; /* Text/Icon starts at 16+12=28px from screen edge */
        
        height: 48px;
        border-radius: var(--gp-radius);
        text-decoration: none;
        color: var(--gp-fg);
        cursor: pointer;
        font-family: var(--gp-font);
        font-size: 14px;
        font-weight: 500;
        line-height: 20px;
        position: relative;
        transition: background 0.1s ease;
      }

      .gp-row:hover {
        background: var(--gp-bg-hover);
      }
      
      /* Removed: Active state background creates visual clutter with stacked pill shapes.
         Only hover is now highlighted for a cleaner look.
      .gp-row.active {
        background: var(--gp-bg-active);
      }
      */

      .gp-label {
        flex: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .gp-new .gp-icon {
        color: var(--gp-fg);
      }

      .gp-icon {
        width: 24px;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        color: var(--gp-fg-muted);
      }
      
      .gp-icon svg { width: 18px; height: 18px; }

      .gp-kebab {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        border: none;
        background: transparent;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--gp-fg-muted);
        cursor: pointer;
        opacity: 0;
        transition: background 0.15s ease, opacity 0.15s ease;
        margin-right: -8px;
        flex-shrink: 0;
      }
      
      .gp-kebab svg {
        width: 20px;
        height: 20px;
      }
      
      .gp-row:hover .gp-kebab, 
      .gp-kebab:focus {
        opacity: 1;
      }
      
      .gp-kebab:hover {
        background: rgba(68, 71, 70, 0.12);
        color: var(--gp-fg);
      }

      .gp-project-chats {
        display: flex;
        flex-direction: column;
        gap: 2px;
        position: relative;
        /* Tree connector line - vertical bar on left side */
        margin-left: 28px; /* Aligns with icon center: 16px padding + 12px (half of 24px icon) */
        padding-left: 24px; /* Space for the line */
        border-left: 1.5px solid rgba(68, 71, 70, 0.15); /* Subtle connector line */
      }

      .gp-chat-row {
        height: 36px;
        /* Scaled padding (16px * 0.75 = 12px) to match project row proportions */
        padding: 0 12px 0 12px;
        margin: 0;
        display: flex;
        align-items: center;
        text-decoration: none;
        color: var(--gp-fg-muted);
        font-family: var(--gp-font);
        font-size: 13px;
        font-weight: 500;
        line-height: 20px;
        border-radius: var(--gp-radius);
        transition: background 0.1s;
      }
      
      .gp-chat-row:hover {
        background: var(--gp-bg-hover);
      }
      
      .gp-chat-row:hover .gp-chat-link {
        color: var(--gp-fg);
      }

      .gp-chat-link {
        flex: 1;
        min-width: 0; /* Allow text truncation */
        display: flex;
        align-items: center;
        height: 100%;
        text-decoration: none;
        color: inherit;
      }

      .gp-chat-title {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      
      .gp-chat-kebab {
        width: 24px;
        height: 24px;
        border-radius: 50%;
        border: none;
        background: transparent;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--gp-fg-muted);
        cursor: pointer;
        opacity: 0;
        transition: background 0.15s ease, opacity 0.15s ease;
        margin-right: -6px; /* Scaled margin (-8px * 0.75 = -6px) */
        flex-shrink: 0;
      }
      
      .gp-chat-kebab svg {
        width: 18px;
        height: 18px;
      }
      
      .gp-chat-row:hover .gp-chat-kebab {
        opacity: 1;
      }
      
      .gp-chat-kebab:hover {
        background: rgba(68, 71, 70, 0.12);
        color: var(--gp-fg);
      }
      
      .gp-chat-empty {
        padding: 8px 16px 8px 52px;
        margin: 0;
        font-size: 12px;
        color: #8e918f;
        font-style: italic;
      }
    `;
    shadow.appendChild(style);
  }
  return root;
}

function buildPanelMarkup(state: RuntimeState): string {
  const collapsed = state.uiPrefs.projectsCollapsed;
  const chevronSvg = `
    <svg viewBox="0 0 24 24">
      <path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `;

  return `
    <div class="gp-panel">
      <!-- Header with Chevron -->
      <div class="gp-title ${collapsed ? 'collapsed' : ''}" data-gp-action="toggle-section" role="button">
        <span>Projects</span>
        <span class="gp-chevron">${chevronSvg}</span>
      </div>
      
      <!-- Collapsible Container -->
      <div class="gp-list-container ${collapsed ? 'hidden' : ''}">
        <div class="gp-row gp-new" data-gp-action="new-project">
          <span class="gp-icon"><svg viewBox="0 0 24 24" width="18" height="18" style="color: #444746;"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></span>
          <span class="gp-label">New Project</span>
        </div>
        ${renderProjectsSection(state.projects, state.chatIndex, state.expandedProjectIds)}
      </div>
    </div>
  `;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function ProjectNameInputWithIcon(): string {
  return `
    <div class="gp-namebox" data-gp-namebox>
      <button class="gp-icon-button" type="button" data-gp-action="icon-picker" aria-label="Choose icon"></button>
      <input class="gp-name-input" data-gp-name-input type="text" placeholder="Project name" />
      <div class="gp-icon-popover" data-gp-icon-popover>
        <div class="gp-icon-grid">
          ${ICON_OPTIONS.map(
    (icon) => `
              <button class="gp-icon-option" type="button" data-gp-icon-option="${icon.id}" title="${icon.label}">
                ${renderIconSvg(icon.id)}
              </button>
            `
  ).join('')}
        </div>
      </div>
    </div>
  `;
}

function ensureOverlayLayer(shadow: ShadowRoot): HTMLElement {
  let layer = shadow.getElementById('gp-overlay-layer') as HTMLElement | null;
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'gp-overlay-layer';
    shadow.appendChild(layer);
  }
  if (!shadow.querySelector('style[data-gp="overlay"]')) {
    const style = document.createElement('style');
    style.dataset.gp = 'overlay';
    style.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=Fraunces:wght@400;500;600;700;800;900&display=swap');

      :host {
        all: initial;
        font-family: inherit;
        color: var(--gp-fg, #1b1a18);
        --gp-font: "Manrope", "Styrene A", "Styrene B", "Inter", "Segoe UI", sans-serif;
        --gp-font-serif: "Fraunces", "Times New Roman", serif;
        --gp-fg: #1b1a18;
        --gp-fg-muted: #5b5954;
        --gp-muted: #838079;
        --gp-border: rgba(91, 89, 84, 0.24);
        --gp-hover: rgba(91, 89, 84, 0.08);
        --gp-hover-strong: rgba(91, 89, 84, 0.14);
        --gp-surface: #ede9e0;
        --gp-surface-2: #f5f2ea;
        --gp-shadow: 0 20px 48px -12px rgba(27, 26, 24, 0.35);
        --gp-radius-xs: 8px;
        --gp-radius-sm: 10px;
        --gp-radius: 12px;
        --gp-radius-lg: 16px;
        --gp-radius-xl: 20px;
        --gp-radius-pill: 999px;
        --gp-accent: #1b1a18;
        --gp-on-accent: #ede9e0;
        --gp-accent-hover: rgba(27, 26, 24, 0.08);
        --gp-focus: #d97c5d;
        --gp-input-bg: rgba(251, 250, 246, 0.76);
      }
      
      :host(.dark) {
        --gp-fg: #ede9e0;
        --gp-fg-muted: #c9c5bc;
        --gp-muted: #a4a19b;
        --gp-border: rgba(237, 233, 224, 0.2);
        --gp-hover: rgba(237, 233, 224, 0.1);
        --gp-hover-strong: rgba(237, 233, 224, 0.16);
        --gp-surface: #1b1a18;
        --gp-surface-2: #23201d;
        --gp-shadow: 0 22px 52px -14px rgba(0, 0, 0, 0.72);
        --gp-accent: #ede9e0;
        --gp-on-accent: #1b1a18;
        --gp-accent-hover: rgba(237, 233, 224, 0.12);
        --gp-focus: #d97c5d;
        --gp-input-bg: rgba(35, 33, 30, 0.84);
      }

      .gp-modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(27, 26, 24, 0.34);
        display: none;
        align-items: center;
        justify-content: center;
        pointer-events: auto;
      }
      .gp-modal {
        background: var(--gp-surface);
        border-radius: var(--gp-radius-xl);
        width: 520px;
        max-width: calc(100vw - 32px);
        box-shadow: var(--gp-shadow);
        border: 1px solid var(--gp-border);
        padding: 20px;
        display: flex;
        flex-direction: column;
        gap: 14px;
        font-family: var(--gp-font);
        color: var(--gp-fg);
        position: relative;
      }
      .gp-modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 19px;
        font-weight: 700;
        font-family: var(--gp-font-serif);
        letter-spacing: 0.01em;
        color: var(--gp-fg);
      }
      .gp-modal-header [data-gp-modal-title] {
        font-family: "Fraunces", serif;
        font-weight: 700;
        font-style: normal;
        font-variation-settings: normal;
        letter-spacing: 0;
        text-rendering: optimizeLegibility;
        -webkit-font-smoothing: antialiased;
      }
      .gp-modal-close {
        border: none;
        background: transparent;
        font-size: 18px;
        cursor: pointer;
        color: var(--gp-muted);
        width: 32px;
        height: 32px;
        border-radius: var(--gp-radius-pill);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: background 120ms ease;
      }
      .gp-modal-close svg { width: 18px; height: 18px; }
      .gp-modal-close:hover { background: var(--gp-hover); }
      .gp-namebox {
        display: flex;
        align-items: center;
        gap: 12px;
        border: 1px solid var(--gp-border);
        border-radius: var(--gp-radius-lg);
        padding: 8px; /* Uniform padding for consistent margins */
        position: relative;
        background: var(--gp-input-bg);
        transition: border-color 120ms ease, box-shadow 120ms ease;
      }
      .gp-namebox:focus-within {
        border-color: var(--gp-focus);
        box-shadow: 0 0 0 2px rgba(217, 124, 93, 0.22);
      }
      .gp-icon-button {
        width: 36px;
        height: 36px;
        border: none;
        border-radius: var(--gp-radius-sm);
        background: var(--gp-input-bg);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: box-shadow 120ms ease, background 120ms ease;
        color: var(--gp-fg);
      }
      .gp-icon-button:hover { background: var(--gp-hover); }
      .gp-icon-button svg { width: 18px; height: 18px; }
      .gp-icon-button:focus-visible {
        outline: none;
        box-shadow: 0 0 0 2px rgba(217, 124, 93, 0.3);
      }
      .gp-name-input {
        flex: 1;
        border: none;
        outline: none;
        background: transparent;
        font-size: 15px;
        color: var(--gp-fg);
        font-family: var(--gp-font);
      }
      .gp-name-input::placeholder { color: var(--gp-muted); }
      .gp-icon-popover {
        position: absolute;
        top: calc(100% + 10px);
        left: 0;
        background: var(--gp-surface);
        border-radius: 20px;
        border: 1px solid var(--gp-border);
        box-shadow: 0 14px 38px rgba(27, 26, 24, 0.24), 0 4px 12px rgba(27, 26, 24, 0.12);
        padding: 16px;
        display: none;
        z-index: 2147483647;
      }
      .gp-icon-grid {
        display: grid;
        /* 精确的6x5等距网格布局 */
        grid-template-columns: repeat(6, 1fr);
        gap: 8px;
        width: 288px; /* (40+8)*6 - 8 = 精确宽度 */
      }
      .gp-icon-option {
        width: 40px;
        height: 40px;
        border: 1.5px solid var(--gp-border);
        border-radius: 12px;
        background: var(--gp-surface);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: all 150ms cubic-bezier(0.4, 0, 0.2, 1);
        color: var(--gp-fg);
      }
      .gp-icon-option:hover {
        border-color: var(--gp-focus);
        background: var(--gp-accent-hover);
        transform: scale(1.05);
        box-shadow: 0 2px 8px rgba(27, 26, 24, 0.18);
      }
      .gp-icon-option:active {
        transform: scale(0.95);
      }
      .gp-icon-option svg { width: 18px; height: 18px; }
      .gp-icon-option:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px rgba(217, 124, 93, 0.35);
      }
      .gp-template-row {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        align-items: center;
      }
      .gp-template-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        border-radius: var(--gp-radius-pill);
        border: 1px solid var(--gp-border);
        cursor: pointer;
        font-size: 13px;
        color: var(--gp-fg);
        background: var(--gp-surface);
        transition: background 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
        line-height: 1;
        height: 32px;
        font-weight: 500;
      }
      .gp-template-chip:hover {
        background: var(--gp-hover);
        border-color: rgba(91, 89, 84, 0.36);
      }
      .gp-template-chip svg { width: 16px; height: 16px; }
      .gp-template-chip:focus-visible { outline: none; box-shadow: 0 0 0 2px rgba(217, 124, 93, 0.28); }
      
      /* Color Picker Row */
      .gp-color-row {
        display: flex;
        gap: 8px;
        align-items: center;
        margin-bottom: 8px;
      }
      .gp-color-dot {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        border: 2px solid transparent;
        cursor: pointer;
        transition: transform 0.15s ease, box-shadow 0.15s ease;
        padding: 0;
        position: relative;
        /* 立体磨砂效果基础 */
        overflow: hidden;
      }
      .gp-color-dot:hover {
        transform: scale(1.12);
      }
      .gp-color-dot.selected {
        box-shadow: 0 0 0 2px var(--gp-surface), 0 0 0 4px currentColor;
      }
      .gp-color-dot:first-child.selected {
        box-shadow: 0 0 0 2px var(--gp-surface), 0 0 0 4px #1f1f1f;
      }
      
      /* Adaptive Color (Black/White) */
      .gp-color-adaptive {
        background-color: #1f1f1f;
        color: #1f1f1f;
      }
      :host(.dark) .gp-color-adaptive {
        background-color: #ffffff;
        color: #ffffff;
      }
      :host(.dark) .gp-color-dot:first-child.selected {
        box-shadow: 0 0 0 2px var(--gp-surface), 0 0 0 4px #ffffff;
      }

      /* 所有颜色的立体磨砂效果 - 移除，回归扁平 */
      .gp-color-dot::before,
      .gp-color-dot::after {
        display: none;
      }
      .gp-color-dot:first-child::before,
      .gp-color-dot:first-child::after {
        display: none;
      }
      
      .gp-modal-actions {
        display: flex;
        justify-content: flex-end;
      }
      .gp-primary {
        background: var(--gp-accent);
        color: var(--gp-on-accent, #fff);
        border: none;
        padding: 8px 20px;
        border-radius: 12px; /* Rounded rectangle instead of pill - cleaner edges */
        cursor: pointer;
        font-weight: 600;
        box-shadow: 0 8px 18px -10px rgba(27, 26, 24, 0.55);
        transition: filter 120ms ease, transform 100ms ease;
        height: 40px;
        min-width: 140px;
      }
      .gp-primary:hover { filter: brightness(0.98); }
      .gp-primary:disabled {
        background: var(--gp-hover-strong);
        color: var(--gp-muted);
        cursor: not-allowed;
        box-shadow: none;
      }
      .gp-menu {
        position: fixed;
        min-width: 220px;
        background: var(--gp-surface);
        border-radius: 16px; /* Outer */
        box-shadow: 0 8px 20px -10px rgba(27, 26, 24, 0.35), 0 2px 8px rgba(27, 26, 24, 0.16);
        border: 1px solid var(--gp-border);
        padding: 6px; /* Padding: 6px */
        display: none;
        pointer-events: auto;
        font-family: var(--gp-font);
        color: var(--gp-fg);
        z-index: 2147483647;
      }
      .gp-menu-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 6px 12px; /* Tighter padding */
        border-radius: 10px; /* Inner: 16 - 6 = 10 */
        cursor: pointer;
        font-size: 14px;
        font-weight: 500;
        color: var(--gp-fg);
        line-height: 20px;
        transition: all 120ms ease;
      }
      .gp-menu-item:hover {
        background: var(--gp-hover);
        transform: none;
      }
      .gp-menu-item.danger { color: #b85a3e; }
      
      /* Chat menu item with icons */
      .gp-chat-menu .gp-menu-item {
        justify-content: flex-start;
        gap: 10px;
      }
      .gp-chat-menu .gp-menu-item svg {
        width: 18px;
        height: 18px;
        flex-shrink: 0;
      }
      .gp-chat-menu .gp-menu-item span {
        flex: 1;
      }
      
      /* Submenu trigger arrow */
      .gp-submenu-arrow {
        width: 16px;
        height: 16px;
        margin-left: auto;
        opacity: 0.6;
      }
      
      /* Submenu panel */
      .gp-submenu {
        position: fixed;
        min-width: 180px;
        background: var(--gp-surface);
        border-radius: 12px;
        box-shadow: 0 8px 20px -10px rgba(27, 26, 24, 0.35), 0 2px 8px rgba(27, 26, 24, 0.16);
        border: 1px solid var(--gp-border);
        padding: 4px;
        display: none;
        z-index: 2147483647;
        font-family: var(--gp-font);
      }
      .gp-submenu .gp-menu-item {
        justify-content: flex-start;
        gap: 8px;
        padding: 6px 10px;
        font-size: 13px;
        border-radius: 8px;
      }
      .gp-submenu .gp-menu-item svg {
        width: 16px;
        height: 16px;
      }
      .gp-toast {
        position: fixed;
        bottom: 24px;
        right: 24px;
        background: #1b1a18;
        color: #ede9e0;
        padding: 10px 16px;
        border-radius: var(--gp-radius-pill);
        font-size: 13px;
        display: none;
        pointer-events: auto;
        border: 1px solid rgba(255, 255, 255, 0.12);
        box-shadow: 0 12px 30px rgba(0, 0, 0, 0.25);
        font-family: var(--gp-font);
      }
    `;
    shadow.appendChild(style);
  }
  return layer;
}

function createModal(layer: HTMLElement) {
  const backdrop = document.createElement('div');
  backdrop.className = 'gp-modal-backdrop';
  backdrop.innerHTML = `
    <div class="gp-modal" role="dialog" aria-modal="true">
      <div class="gp-modal-header">
        <span data-gp-modal-title>Create Project</span>
        <button class="gp-modal-close" data-gp-action="close" aria-label="Close">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
          </svg>
        </button>
      </div>
      ${ProjectNameInputWithIcon()}
      <div class="gp-color-row" data-gp-color-row>
        ${COLOR_OPTIONS.map(
    (opt, idx) => {
      const isAdaptive = idx === 0; // First one is 'Black'
      const style = isAdaptive ? '' : `background-color: ${opt.color}; color: ${opt.color};`;
      const adaptiveClass = isAdaptive ? 'gp-color-adaptive' : '';
      return `
            <button class="gp-color-dot ${idx === 0 ? 'selected' : ''} ${adaptiveClass}" 
                    data-gp-color="${opt.color}" 
                    title="${opt.label}"
                    style="${style}">
            </button>
          `;
    }
  ).join('')}
      </div>
      <div class="gp-template-row" data-gp-template-row>
        ${ICON_OPTIONS.map(
    (icon) => `
            <div class="gp-template-chip" data-gp-template="${icon.id}" data-gp-template-label="${icon.label}">
              ${renderIconSvg(icon.id)}
              <span>${icon.label}</span>
            </div>
          `
  ).join('')}
      </div>
      <div class="gp-modal-actions">
        <button class="gp-primary" data-gp-action="confirm" disabled>Create Project</button>
      </div>
    </div>
  `;
  layer.appendChild(backdrop);

  function open(config: { title: string; confirmLabel: string; name: string; showIcons: boolean }) {
    const title = backdrop.querySelector<HTMLElement>('[data-gp-modal-title]');
    const confirm = backdrop.querySelector<HTMLButtonElement>('[data-gp-action="confirm"]');
    const input = backdrop.querySelector<HTMLInputElement>('[data-gp-name-input]');
    const templateRow = backdrop.querySelector<HTMLElement>('[data-gp-template-row]');
    if (title) title.textContent = config.title;
    if (confirm) confirm.textContent = config.confirmLabel;
    if (input) input.value = config.name;
    if (templateRow) templateRow.style.display = config.showIcons ? 'flex' : 'none';
    const popover = backdrop.querySelector<HTMLElement>('[data-gp-icon-popover]');
    if (popover) popover.style.display = 'none';
    backdrop.style.display = 'flex';
  }

  function close() {
    backdrop.style.display = 'none';
  }

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) {
      close();
    }
  });

  const closeButton = backdrop.querySelector<HTMLButtonElement>('[data-gp-action="close"]');
  closeButton?.addEventListener('click', () => close());

  return { element: backdrop, open, close };
}

function createProjectMenu(layer: HTMLElement) {
  const menu = document.createElement('div');
  menu.className = 'gp-menu';
  layer.appendChild(menu);

  let callbacks: { onEdit: () => void; onDelete: () => void } | null = null;

  function open(anchorRect: DOMRect, _project: Project, nextCallbacks: { onEdit: () => void; onDelete: () => void }) {
    callbacks = nextCallbacks;
    menu.innerHTML = `
      <div class="gp-menu-item" data-gp-menu="edit">Edit Project</div>
      <div class="gp-menu-item danger" data-gp-menu="delete">Delete Project</div>
    `;
    const left = Math.min(anchorRect.left, window.innerWidth - 220);
    const top = anchorRect.bottom + 6;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.display = 'block';
  }

  function close() {
    menu.style.display = 'none';
  }

  menu.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest('[data-gp-menu]') as HTMLElement | null;
    if (!target || !callbacks) {
      return;
    }
    const action = target.dataset.gpMenu;
    if (action === 'edit') callbacks.onEdit();
    if (action === 'delete') callbacks.onDelete();
    close();
  });

  document.addEventListener('click', (event) => {
    if (!menu.contains(event.target as Node)) {
      close();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      close();
    }
  });

  return { open, close };
}

// 聊天项右键菜单 (Chat row context menu)
function createChatMenu(layer: HTMLElement, getProjects: () => Project[]) {
  const menu = document.createElement('div');
  menu.className = 'gp-menu gp-chat-menu';
  layer.appendChild(menu);

  let callbacks: {
    onRemove: () => void;
    onMoveToProject: (projectId: string) => void;
  } | null = null;
  let currentProjectId: string | null = null;
  let currentProjectName: string = '';

  function open(
    anchorRect: DOMRect,
    chatId: string,
    projectId: string,
    projectName: string,
    nextCallbacks: {
      onRemove: () => void;
      onMoveToProject: (projectId: string) => void;
    }
  ) {
    callbacks = nextCallbacks;
    currentProjectId = projectId;
    currentProjectName = projectName;

    // 获取其他项目列表（排除当前项目）
    const otherProjects = getProjects().filter(p => p.id !== projectId);

    menu.innerHTML = `
      <div class="gp-menu-item" data-gp-chat-action="remove">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
          <polyline points="16 17 21 12 16 7"/>
          <line x1="21" y1="12" x2="9" y2="12"/>
        </svg>
        <span>Remove from ${escapeHtml(projectName)}</span>
      </div>
      ${otherProjects.length > 0 ? `
        <div class="gp-menu-item gp-submenu-trigger" data-gp-chat-action="move-trigger">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
            <line x1="12" y1="11" x2="12" y2="17"/>
            <line x1="9" y1="14" x2="15" y2="14"/>
          </svg>
          <span>Move to Project</span>
          <svg class="gp-submenu-arrow" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </div>
        <div class="gp-submenu" data-gp-submenu="move">
          ${otherProjects.map(p => `
            <div class="gp-menu-item" data-gp-chat-action="move" data-gp-target-project="${p.id}">
              ${renderIconSvg(p.icon, p.color)}
              <span>${escapeHtml(p.name)}</span>
            </div>
          `).join('')}
        </div>
      ` : ''}
    `;

    // 定位菜单
    const left = Math.min(anchorRect.left, window.innerWidth - 240);
    const top = anchorRect.bottom + 6;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.display = 'block';

    // 子菜单悬停显示
    const trigger = menu.querySelector('.gp-submenu-trigger');
    const submenu = menu.querySelector('.gp-submenu') as HTMLElement | null;
    if (trigger && submenu) {
      trigger.addEventListener('mouseenter', () => {
        submenu.style.display = 'block';
        const triggerRect = trigger.getBoundingClientRect();
        submenu.style.left = `${triggerRect.right - 4}px`;
        submenu.style.top = `${triggerRect.top}px`;
      });
      trigger.addEventListener('mouseleave', (e) => {
        const related = (e as MouseEvent).relatedTarget as HTMLElement | null;
        if (related && submenu.contains(related)) return;
        submenu.style.display = 'none';
      });
      submenu.addEventListener('mouseleave', () => {
        submenu.style.display = 'none';
      });
    }
  }

  function close() {
    menu.style.display = 'none';
    const submenu = menu.querySelector('.gp-submenu') as HTMLElement | null;
    if (submenu) submenu.style.display = 'none';
  }

  menu.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest('[data-gp-chat-action]') as HTMLElement | null;
    if (!target || !callbacks) return;

    const action = target.dataset.gpChatAction;
    if (action === 'remove') {
      callbacks.onRemove();
      close();
    } else if (action === 'move') {
      const targetProjectId = target.dataset.gpTargetProject;
      if (targetProjectId) {
        callbacks.onMoveToProject(targetProjectId);
        close();
      }
    }
  });

  document.addEventListener('click', (event) => {
    if (!menu.contains(event.target as Node)) {
      close();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      close();
    }
  });

  return { open, close };
}

function createToast(layer: HTMLElement) {
  const toast = document.createElement('div');
  toast.className = 'gp-toast';
  layer.appendChild(toast);
  let timeoutId: number | null = null;

  function show(message: string) {
    toast.textContent = message;
    toast.style.display = 'block';
    if (timeoutId) {
      window.clearTimeout(timeoutId);
    }
    timeoutId = window.setTimeout(() => {
      toast.style.display = 'none';
    }, 2200);
  }

  function hide() {
    toast.style.display = 'none';
  }

  return { show, hide };
}

function navigateToChatViaNativeLink(conversationId: string, fallbackHref: string) {
  const nativeLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/app/"]'));
  const nativeLink = nativeLinks.find((link) => {
    if (!link.href.includes(`/app/${conversationId}`)) return false;
    return !!link.closest('nav, aside, [role="navigation"], [role="complementary"]');
  });

  if (nativeLink) {
    nativeLink.click();
    return;
  }

  if (fallbackHref) {
    window.location.assign(fallbackHref);
  }
}

function attachThemeObserver(panelRoot: HTMLElement, overlayLayer: HTMLElement) {
  const getHost = (el: HTMLElement) => (el.getRootNode() as ShadowRoot).host as HTMLElement;
  const panelHost = getHost(panelRoot);
  const overlayHost = getHost(overlayLayer);

  const applyTheme = () => {
    // Check for "dark" in class list (Gemini typically uses "dark-theme" or similar)
    // We strictly check for *presence* of likely dark classes
    const bodyClass = document.body.className.toLowerCase();
    const isDark = bodyClass.includes('dark');

    if (panelHost) panelHost.classList.toggle('dark', isDark);
    if (overlayHost) overlayHost.classList.toggle('dark', isDark);
  };

  const observer = new MutationObserver(applyTheme);
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  applyTheme(); // Initial check
}
