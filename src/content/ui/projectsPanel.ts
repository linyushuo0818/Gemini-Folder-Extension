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
  let panelEventsController: AbortController | null = null;

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
    panelEventsController?.abort();
    panelEventsController = new AbortController();

    panelRoot.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      const chatMenuButton = target.closest<HTMLButtonElement>('[data-gp-action="chat-menu"]');
      if (chatMenuButton) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        const chatRow = chatMenuButton.closest<HTMLElement>('[data-gp-chat-id]');
        if (!chatRow) return;
        const chatId = chatRow.dataset.gpChatId as string;
        const chatProjectId = chatRow.dataset.gpProjectId as string;
        const project = state.projects.find((p) => p.id === chatProjectId);
        if (project) {
          chatMenu.open(
            chatMenuButton.getBoundingClientRect(),
            chatId,
            chatProjectId,
            project.name,
            {
              onRemove: () => options.onRemoveChatFromProject(chatId),
              onMoveToProject: (targetProjectId) => options.onMoveChatToProject(chatId, targetProjectId)
            }
          );
        }
        return;
      }

      const chatRow = target.closest<HTMLElement>('[data-gp-chat-id]');
      if (chatRow) {
        const mouseEvent = event as MouseEvent;
        if (mouseEvent.button !== 0 || mouseEvent.metaKey || mouseEvent.ctrlKey || mouseEvent.shiftKey || mouseEvent.altKey) {
          return;
        }
        if (chatRow.classList.contains('missing')) {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          showToast('This chat is no longer in Gemini history. It may have been deleted on another device.');
          return;
        }
        const chatId = chatRow.dataset.gpChatId as string;
        const chatLink = chatRow.querySelector<HTMLAnchorElement>('.gp-chat-link');
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        navigateToProjectChat(chatId, chatLink?.href || `/app/${chatId}`);
        return;
      }

      const projectMenuButton = target.closest<HTMLButtonElement>('[data-gp-action="project-menu"]');
      if (projectMenuButton) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        const projectRow = projectMenuButton.closest<HTMLElement>('[data-gp-project-id]');
        const projectId = projectRow?.dataset.gpProjectId;
        const project = state.projects.find((item) => item.id === projectId);
        if (project) {
          openProjectMenu(project, projectMenuButton.getBoundingClientRect());
        }
        return;
      }

      const newProjectRow = target.closest<HTMLElement>('[data-gp-action="new-project"]');
      if (newProjectRow) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        openCreateModal();
        return;
      }

      const header = target.closest<HTMLElement>('[data-gp-action="toggle-section"]');
      if (header) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        options.onToggleCollapse(!state.uiPrefs.projectsCollapsed);
        return;
      }

      const toggleRow = target.closest<HTMLElement>('[data-gp-action="toggle-project"]');
      if (toggleRow) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        const projectRow = toggleRow.closest<HTMLElement>('[data-gp-project-id]');
        const projectId = projectRow?.dataset.gpProjectId;
        if (projectId) {
          options.onToggleProjectExpand(projectId);
        }
      }
    }, { capture: true, signal: panelEventsController.signal });

    return;

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

        chatRow.addEventListener('click', (event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
            return;
          }
          if ((event.target as HTMLElement).closest('[data-gp-action="chat-menu"]')) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          navigateToProjectChat(chatId, chatLink?.href || `/app/${chatId}`);
        }, true);

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
    modalSelectedColor = '#1f1f1f';
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

  function syncModalIconSelection() {
    modal.element.querySelectorAll<HTMLElement>('[data-gp-template]').forEach((option) => {
      const isSelected = option.dataset.gpTemplate === modalSelectedIcon;
      option.classList.toggle('selected', isSelected);
      option.setAttribute('aria-pressed', String(isSelected));
    });

    modal.element.querySelectorAll<HTMLElement>('[data-gp-icon-option]').forEach((option) => {
      const isSelected = option.dataset.gpIconOption === modalSelectedIcon;
      option.classList.toggle('selected', isSelected);
      option.setAttribute('aria-pressed', String(isSelected));
    });
  }

  function syncModalColorSelection() {
    modal.element.querySelectorAll<HTMLElement>('[data-gp-color]').forEach((option) => {
      const isSelected = option.dataset.gpColor === modalSelectedColor;
      option.classList.toggle('selected', isSelected);
      option.setAttribute('aria-pressed', String(isSelected));
    });
  }

  function createProjectFromTemplate(
    templateName: string,
    templateIcon: ProjectIcon,
    input?: HTMLInputElement,
    confirm?: HTMLButtonElement
  ) {
    modalSelectedIcon = templateIcon;
    updateIconButton();
    syncModalIconSelection();
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
    syncModalIconSelection();
    syncModalColorSelection();

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
        syncModalIconSelection();
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
          syncModalColorSelection();
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
  expandedProjectIds: Set<string>,
  nativeConversationIds: Set<string> = new Set(),
  nativeChatsReady = false
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
      const accentColor = getProjectAccentColor(project);

      const chatRows = isExpanded
        ? `
          <div class="gp-project-chats" style="--gp-project-color: ${escapeAttr(accentColor)};">
            ${chats.length
          ? chats
            .map(
              (chat) => {
                const isMissing = nativeChatsReady && !nativeConversationIds.has(chat.conversationId);
                return `
                        <div class="gp-chat-row ${isMissing ? 'missing' : ''}" data-gp-chat-id="${chat.conversationId}" data-gp-project-id="${project.id}">
                          <a class="gp-chat-link" href="${escapeHtml(chat.lastUrl || `/app/${chat.conversationId}`)}">
                            <span class="gp-chat-color" aria-hidden="true"></span>
                            <span class="gp-chat-title">${escapeHtml(chat.title || 'Untitled chat')}</span>
                            ${isMissing ? '<span class="gp-chat-missing">Missing</span>' : ''}
                          </a>
                          <button class="gp-chat-kebab" data-gp-action="chat-menu" aria-label="Chat menu"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg></button>
                        </div>
                      `
              }
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
            <button class="gp-kebab" data-gp-action="project-menu" aria-label="Project menu"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg></button>
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
        --gp-fg-muted: #5f6368;
        --gp-section: rgba(0, 0, 0, 0.54);
        --gp-bg-hover: rgba(31, 31, 31, 0.06); 
        --gp-bg-active: #f1f3f4;
        
        --gp-radius: 24px;
        --gp-spacing-row: 0px;
        
        display: block;
        width: 100%;
        pointer-events: auto;
        position: relative;
        isolation: isolate;
        padding-top: 8px;
      }
      
      :host(.dark) {
        --gp-fg: #e3e3e3;
        --gp-fg-muted: #bdc1c6;
        --gp-section: rgba(255, 255, 255, 0.62);
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
        pointer-events: auto;
      }

      .gp-title {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: 6px;
        margin: 0;
        padding: 0 14px; 
        height: 32px;
        color: var(--gp-section); 
        font-family: var(--gp-font);
        font-size: 13px;
        font-weight: 400;
        line-height: 17px;
        cursor: pointer;
        user-select: none;
        border-radius: 0;
        transition: background 0.1s ease;
      }
      
      .gp-title:hover {
        background: transparent;
        color: var(--gp-fg-muted);
      }

      .gp-chevron {
        width: 18px;
        height: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: transform 0.2s cubic-bezier(0.2, 0, 0, 1);
        color: var(--gp-fg-muted);
        opacity: 0.75;
      }
      
      .gp-chevron svg {
        width: 16px; 
        height: 16px;
        fill: none;
      }

      .gp-title.collapsed .gp-chevron {
        transform: rotate(-90deg);
      }

      .gp-list-container {
        display: flex;
        flex-direction: column;
        gap: 0;
        overflow: hidden;
        padding-top: 0;
      }
      
      .gp-list-container.hidden {
        display: none;
      }

      .gp-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0 0 0 6px;
        padding: 0 8px;
        width: calc(100% - 6px);
        height: 32px;
        border-radius: var(--gp-radius);
        text-decoration: none;
        color: var(--gp-fg);
        cursor: pointer;
        font-family: var(--gp-font);
        font-size: 13px;
        font-weight: 400;
        line-height: 17px;
        position: relative;
        transition: background 0.1s ease;
        pointer-events: auto;
      }

      .gp-row:hover {
        background: var(--gp-bg-hover);
      }

      .gp-row.gp-force-hover {
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
        font-size: 13px;
        font-weight: 400;
        line-height: 17px;
      }

      .gp-new .gp-icon {
        color: #3c4043;
      }

      .gp-icon {
        width: 24px;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        color: var(--gp-fg-muted);
        line-height: 0;
      }
      
      .gp-icon svg {
        width: 20px;
        height: 20px;
        display: block;
        flex: 0 0 20px;
      }

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
      .gp-row.gp-force-hover .gp-kebab,
      .gp-kebab:focus {
        opacity: 1;
      }
      
      .gp-kebab:hover {
        background: var(--gp-bg-active);
        color: var(--gp-fg);
      }

      .gp-project-chats {
        display: flex;
        flex-direction: column;
        gap: 0;
        position: relative;
        margin-left: 30px;
        padding-left: 20px;
        border-left: 1px solid color-mix(in srgb, var(--gp-project-color) 45%, transparent);
      }

      .gp-chat-row {
        height: 32px;
        padding: 0 8px 0 12px;
        margin: 0;
        display: flex;
        align-items: center;
        text-decoration: none;
        color: var(--gp-fg-muted);
        font-family: var(--gp-font);
        font-size: 13px;
        font-weight: 400;
        line-height: 20px;
        border-radius: var(--gp-radius);
        transition: background 0.1s;
        pointer-events: auto;
      }
      
      .gp-chat-row:hover {
        background: var(--gp-bg-hover);
      }

      .gp-chat-row.gp-force-hover {
        background: var(--gp-bg-hover);
      }

      .gp-chat-row.missing {
        color: var(--gp-section);
      }
      
      .gp-chat-row:hover .gp-chat-link {
        color: var(--gp-fg);
      }

      .gp-chat-row.missing:hover .gp-chat-link {
        color: var(--gp-fg-muted);
      }

      .gp-chat-row.gp-force-hover .gp-chat-link {
        color: var(--gp-fg);
      }

      .gp-chat-link {
        flex: 1;
        min-width: 0; /* Allow text truncation */
        display: flex;
        align-items: center;
        gap: 8px;
        height: 100%;
        text-decoration: none;
        color: inherit;
        pointer-events: auto;
      }

      .gp-chat-color {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--gp-project-color);
        flex: 0 0 6px;
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--gp-project-color) 18%, transparent);
      }

      .gp-chat-title {
        flex: 1;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .gp-chat-missing {
        flex: 0 0 auto;
        margin-left: 4px;
        padding: 0 6px;
        border-radius: 999px;
        border: 1px solid rgba(95, 99, 104, 0.22);
        color: var(--gp-fg-muted);
        background: rgba(95, 99, 104, 0.06);
        font-size: 10px;
        font-weight: 600;
        line-height: 16px;
        text-transform: uppercase;
        letter-spacing: 0;
      }

      :host(.dark) .gp-chat-missing {
        border-color: rgba(189, 193, 198, 0.22);
        background: rgba(189, 193, 198, 0.1);
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
      
      .gp-chat-row:hover .gp-chat-kebab,
      .gp-chat-row.gp-force-hover .gp-chat-kebab {
        opacity: 1;
      }
      
      .gp-chat-kebab:hover {
        background: var(--gp-bg-active);
        color: var(--gp-fg);
      }
      
      .gp-chat-empty {
        padding: 8px 16px 8px 52px;
        margin: 0;
        font-size: 12px;
        color: var(--gp-section);
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
          <span class="gp-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg></span>
          <span class="gp-label">New Project</span>
        </div>
        ${renderProjectsSection(
    state.projects,
    state.chatIndex,
    state.expandedProjectIds,
    state.nativeConversationIds,
    state.nativeChatsReady
  )}
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

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function getProjectAccentColor(project: Project): string {
  const color = project.color || '';
  if (/^#[0-9a-f]{3,8}$/i.test(color) && color.toLowerCase() !== '#1f1f1f') {
    return color;
  }
  return 'var(--gp-fg-muted)';
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
      :host {
        all: initial;
        font-family: inherit;
        color: var(--gp-fg, #1f1f1f);
        --gp-font: "Google Sans Flex", "Google Sans", "Helvetica Neue", "Segoe UI", Roboto, Arial, sans-serif;
        --gp-font-serif: var(--gp-font);
        --gp-fg: #1f1f1f;
        --gp-fg-muted: #5f6368;
        --gp-muted: #747775;
        --gp-border: rgba(60, 64, 67, 0.12);
        --gp-hover: #f1f3f4;
        --gp-hover-strong: rgba(26, 115, 232, 0.12);
        --gp-surface: #ffffff;
        --gp-surface-2: #f8fafd;
        --gp-shadow: 0 16px 40px rgba(60, 64, 67, 0.18), 0 1px 3px rgba(60, 64, 67, 0.16);
        --gp-radius-xs: 8px;
        --gp-radius-sm: 8px;
        --gp-radius: 14px;
        --gp-radius-lg: 14px;
        --gp-radius-xl: 20px;
        --gp-radius-pill: 999px;
        --gp-transition: .18s ease;
        --gp-accent: #1a73e8;
        --gp-on-accent: #ffffff;
        --gp-accent-hover: rgba(26, 115, 232, 0.10);
        --gp-focus: #1a73e8;
        --gp-focus-ring: rgba(26, 115, 232, 0.16);
        --gp-input-bg: #f8fafd;
      }
      
      :host(.dark) {
        --gp-fg: #e8eaed;
        --gp-fg-muted: #bdc1c6;
        --gp-muted: #9aa0a6;
        --gp-border: rgba(232, 234, 237, 0.16);
        --gp-hover: rgba(255, 255, 255, 0.08);
        --gp-hover-strong: rgba(138, 180, 248, 0.18);
        --gp-surface: #202124;
        --gp-surface-2: #292a2d;
        --gp-shadow: 0 24px 52px rgba(0, 0, 0, 0.45), 0 1px 3px rgba(0, 0, 0, 0.36);
        --gp-accent: #8ab4f8;
        --gp-on-accent: #202124;
        --gp-accent-hover: rgba(138, 180, 248, 0.18);
        --gp-focus: #8ab4f8;
        --gp-focus-ring: rgba(138, 180, 248, 0.22);
        --gp-input-bg: rgba(41, 42, 45, 0.92);
      }

      .gp-modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(32, 33, 36, 0.24);
        display: none;
        align-items: center;
        justify-content: center;
        pointer-events: auto;
      }
      .gp-modal {
        --gp-icon-size: 48px;
        --gp-icon-gap: 12px;
        --gp-content-width: calc(var(--gp-icon-size) * 10 + var(--gp-icon-gap) * 9);
        background: var(--gp-surface);
        border-radius: var(--gp-radius-xl);
        width: calc(var(--gp-content-width) + 42px);
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
        font-weight: 800;
        font-family: var(--gp-font);
        letter-spacing: 0.01em;
        color: var(--gp-fg);
      }
      .gp-modal-header [data-gp-modal-title] {
        font-family: var(--gp-font);
        font-weight: 800;
        font-style: normal;
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
        transition: background var(--gp-transition);
      }
      .gp-modal-close svg { width: 18px; height: 18px; }
      .gp-modal-close:hover { background: var(--gp-hover); }
      .gp-namebox {
        display: flex;
        align-items: center;
        gap: 12px;
        width: var(--gp-content-width);
        max-width: 100%;
        margin-left: auto;
        margin-right: auto;
        border: 1px solid var(--gp-border);
        border-radius: var(--gp-radius-xl);
        padding: 8px; /* Uniform padding for consistent margins */
        position: relative;
        background: var(--gp-input-bg);
        transition: border-color var(--gp-transition), box-shadow var(--gp-transition);
      }
      .gp-namebox:focus-within {
        border-color: var(--gp-fg);
        box-shadow: inset 0 0 0 1px var(--gp-fg);
      }
      .gp-icon-button {
        width: 38px;
        height: 38px;
        border: none;
        border-radius: var(--gp-radius-sm);
        background: var(--gp-input-bg);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: box-shadow var(--gp-transition), background var(--gp-transition);
        color: var(--gp-fg);
      }
      .gp-icon-button:hover { background: var(--gp-hover); }
      .gp-icon-button svg {
        width: 22px;
        height: 22px;
        stroke-width: 2.35;
      }
      .gp-icon-button:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px var(--gp-focus-ring);
      }
      .gp-name-input {
        flex: 1;
        min-width: 0;
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
        border-radius: var(--gp-radius-xl);
        border: 1px solid var(--gp-border);
        box-shadow: 0 16px 36px rgba(60, 64, 67, 0.22);
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
        border-radius: 10px;
        background: var(--gp-surface);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: border-color var(--gp-transition), background var(--gp-transition), transform var(--gp-transition), box-shadow var(--gp-transition);
        color: var(--gp-fg);
      }
      .gp-icon-option:hover {
        border-color: var(--gp-focus);
        background: var(--gp-accent-hover);
        transform: none;
      }
      .gp-icon-option:active {
        transform: translateY(0);
      }
      .gp-icon-option svg { width: 18px; height: 18px; }
      .gp-icon-option.selected {
        border-color: var(--gp-focus);
        background: var(--gp-accent-hover);
        color: var(--gp-focus);
        box-shadow: 0 0 0 2px var(--gp-surface), 0 0 0 4px var(--gp-focus);
      }
      .gp-icon-option:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px var(--gp-focus-ring);
      }
      .gp-template-row {
        display: flex;
        gap: var(--gp-icon-gap);
        flex-wrap: wrap;
        align-items: center;
        width: var(--gp-content-width);
        max-width: 100%;
        margin-left: auto;
        margin-right: auto;
      }
      .gp-template-chip {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: var(--gp-icon-size);
        height: var(--gp-icon-size);
        padding: 0;
        border-radius: 10px;
        border: 1px solid var(--gp-border);
        cursor: pointer;
        color: var(--gp-fg);
        background: var(--gp-surface);
        transition: background var(--gp-transition), border-color var(--gp-transition), box-shadow var(--gp-transition), transform var(--gp-transition);
        flex: 0 0 auto;
      }
      .gp-template-chip:hover {
        border-color: var(--gp-focus);
        background: var(--gp-accent-hover);
        transform: none;
      }
      .gp-template-chip:active { transform: translateY(0); }
      .gp-template-chip.selected {
        border-color: var(--gp-focus);
        background: var(--gp-accent-hover);
        color: var(--gp-focus);
        box-shadow: 0 0 0 2px var(--gp-surface), 0 0 0 4px var(--gp-focus);
      }
      .gp-template-chip svg {
        width: 24px;
        height: 24px;
        stroke-width: 2.15;
      }
      .gp-template-chip:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--gp-focus-ring); }
      
      /* Color Picker Row */
      .gp-color-row {
        display: flex;
        gap: 10px;
        align-items: center;
        width: var(--gp-content-width);
        max-width: 100%;
        margin-left: auto;
        margin-right: auto;
        margin-bottom: 8px;
      }
      .gp-color-dot {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        border: 2px solid transparent;
        cursor: pointer;
        transition: transform var(--gp-transition), box-shadow var(--gp-transition);
        padding: 0;
        position: relative;
        /* 立体磨砂效果基础 */
        overflow: hidden;
      }
      .gp-color-dot:hover {
        transform: translateY(-1px);
      }
      .gp-color-dot.selected {
        box-shadow: 0 0 0 2px var(--gp-surface), 0 0 0 4px var(--gp-focus);
      }
      .gp-color-dot:first-child.selected {
        box-shadow: 0 0 0 2px var(--gp-surface), 0 0 0 4px var(--gp-focus);
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
        box-shadow: 0 0 0 2px var(--gp-surface), 0 0 0 4px var(--gp-focus);
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
        width: var(--gp-content-width);
        max-width: 100%;
        margin-left: auto;
        margin-right: auto;
        margin-top: 4px;
      }
      .gp-primary {
        background: var(--gp-focus);
        color: var(--gp-on-accent);
        border: 1px solid var(--gp-focus);
        padding: 0 22px;
        border-radius: var(--gp-radius-lg);
        cursor: pointer;
        font-family: var(--gp-font);
        font-size: 15px;
        font-weight: 800;
        letter-spacing: 0;
        -webkit-font-smoothing: antialiased;
        box-shadow: none;
        transition: background var(--gp-transition), border-color var(--gp-transition), transform var(--gp-transition);
        height: 46px;
        min-width: 156px;
        overflow: hidden;
      }
      .gp-primary:hover {
        background: #1967d2;
        border-color: #1967d2;
        transform: none;
      }
      :host(.dark) .gp-primary:hover {
        background: #aecbfa;
        border-color: #aecbfa;
      }
      .gp-primary:disabled {
        background: var(--gp-hover);
        border-color: var(--gp-border);
        color: var(--gp-muted);
        cursor: not-allowed;
        box-shadow: none;
      }
      .gp-menu {
        position: fixed;
        min-width: 220px;
        background: var(--gp-surface);
        border-radius: var(--gp-radius-xl);
        box-shadow: 0 8px 20px rgba(60, 64, 67, 0.18);
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
        border-radius: var(--gp-radius); /* Inner: 20 - 6 ~= 14 */
        cursor: pointer;
        font-size: 14px;
        font-weight: 500;
        color: var(--gp-fg);
        line-height: 20px;
        transition: background var(--gp-transition), color var(--gp-transition);
      }
      .gp-menu-item:hover {
        background: var(--gp-hover);
        transform: none;
      }
      .gp-menu-item.danger { color: #b3261e; }
      
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
        border-radius: var(--gp-radius-lg);
        box-shadow: 0 8px 20px rgba(60, 64, 67, 0.18);
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
        border-radius: var(--gp-radius-sm);
      }
      .gp-submenu .gp-menu-item svg {
        width: 16px;
        height: 16px;
      }
      .gp-toast {
        position: fixed;
        bottom: 24px;
        right: 24px;
        background: #202124;
        color: #ffffff;
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
            <button class="gp-template-chip" type="button" data-gp-template="${icon.id}" data-gp-template-label="${icon.label}" title="${icon.label}" aria-label="${icon.label}" aria-pressed="false">
              ${renderIconSvg(icon.id)}
            </button>
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

function navigateToProjectChat(conversationId: string, fallbackHref: string) {
  const before = window.location.href;
  const targetUrl = new URL(fallbackHref, window.location.origin).href;
  if (before === targetUrl) {
    return;
  }

  const nativeLink = findNativeChatLink(conversationId);
  if (nativeLink) {
    nativeLink.click();
    window.setTimeout(() => {
      if (window.location.href === before) {
        window.location.assign(targetUrl);
      }
    }, 200);
    return;
  }

  window.location.assign(targetUrl);
}

function findNativeChatLink(conversationId: string): HTMLAnchorElement | null {
  const nativeLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/app/"]'));
  return nativeLinks.find((link) => {
    if (!link.href.includes(`/app/${conversationId}`)) return false;
    if (!link.closest('nav, aside, [role="navigation"], [role="complementary"]')) return false;
    return true;
  }) || null;
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
