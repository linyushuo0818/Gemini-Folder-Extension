import { ChatRef, DEFAULT_PROJECT_ICON_STYLE, Project, ProjectIcon, ProjectIconStyle, PROJECT_ICON_STYLES, RuntimeState } from '../../shared/types';
import { exportAllData, triggerImport } from '../../shared/backup';
import { isProjectIconStyle } from '../../shared/storage';
import { CloudSyncStatus, createDefaultSyncStatus } from '../../shared/sync';
import {
  ADAPTIVE_PROJECT_COLOR, COLOR_OPTIONS, ICON_OPTIONS, MULTICOLOR_ICON_PALETTE,
  getIconLabel, getPaletteIconColor, renderIconSvg, resolveProjectIconColor
} from './icons';
import { renderUiIcon, UiIconName } from './uiIcons';
import { showSurface, hideSurface, setSurfaceOrigin, installMotionStyles, shouldAnimateMotion, MOTION_EASE } from './motion';
import { PROJECT_ICON_STYLE_CSS } from './projectIconStyle';
import { PANEL_TITLE_TYPOGRAPHY } from './typography';
import { SURFACE_THEME_CSS } from './surfaceTheme';
import { RADIUS_TOKENS_CSS } from './radii';
import { observeGeminiTheme } from './theme';
import { moveMenuFocus } from '../dom/menus';
import { clearActiveDraggedChat, getActiveDraggedChat, setActiveDraggedChat } from '../dom/dragState';

interface ProjectsPanelOptions {
  shadow: ShadowRoot;
  overlayShadow: ShadowRoot;
  getSyncStatus: () => CloudSyncStatus;
  onSyncNow: () => Promise<CloudSyncStatus>;
  onConnectGoogleDrive: () => Promise<CloudSyncStatus>;
  onDisconnectGoogleDrive: () => Promise<CloudSyncStatus>;
  onSaveProject: (project: Project, editing: boolean) => Promise<void>;
  onToggleProjectPin: (projectId: string, isPinned: boolean) => Promise<void>;
  onToggleProjectExpand: (projectId: string) => void;
  onDeleteProject: (projectId: string) => void;
  onToggleCollapse: (collapsed: boolean) => void;
  onRemoveChatFromProject: (conversationId: string) => Promise<void>;
  onMoveChatToProject: (conversationId: string, projectId: string) => Promise<void>;
}

type ModalMode = 'create' | 'edit';
const MULTICOLOR = 'multicolor';
const PANEL_COLLAPSE_ANIMATION_MS = 190;
const PROJECT_COLLAPSE_ANIMATION_MS = 180;

const PROJECT_ACTION_ICONS: Record<'pin' | 'unpin' | 'edit' | 'delete', UiIconName> = {
  pin: 'pin',
  unpin: 'pinOff',
  edit: 'pencil',
  delete: 'trash'
};

function renderProjectActionIcon(action: keyof typeof PROJECT_ACTION_ICONS): string {
  return renderUiIcon(PROJECT_ACTION_ICONS[action], 18);
}

export function createProjectsPanel(options: ProjectsPanelOptions) {
  const lifecycleController = new AbortController();
  const panelRoot = ensurePanelRoot(options.shadow);
  installMotionStyles(panelRoot);
  const overlayLayer = ensureOverlayLayer(options.overlayShadow);
  const modal = createModal(overlayLayer, lifecycleController.signal);
  const projectMenu = createProjectMenu(overlayLayer, lifecycleController.signal);
  const sectionMenu = createSectionMenu(overlayLayer, lifecycleController.signal);
  const toast = createToast(overlayLayer);

  const stopThemeObserver = attachThemeObserver(panelRoot, overlayLayer);

  // 用于存储当前 state 以供 chatMenu 获取项目列表
  let currentState: RuntimeState | null = null;
  let currentSyncStatus: CloudSyncStatus = options.getSyncStatus?.() ?? createDefaultSyncStatus();
  const chatMenu = createChatMenu(overlayLayer, () => currentState?.projects || [], lifecycleController.signal);
  let panelEventsController: AbortController | null = null;

  let modalMode: ModalMode = 'create';
  let modalProjectId: string | null = null;
  let modalProject: Project | null = null;
  let modalSelectedIcon: ProjectIcon = 'default';
  let modalIconStyle: ProjectIconStyle = DEFAULT_PROJECT_ICON_STYLE;
  let modalSelectedColor = MULTICOLOR;
  let inputDirty = false;
  let iconButton: HTMLButtonElement | null = null;

  let structureSignature = '';
  let pinnedSnapshot = new Map<string, boolean>();

  const iconStyleInputs = modal.element.querySelectorAll<HTMLInputElement>('[name="gp-project-icon-style"]');
  const iconOptions = modal.element.querySelectorAll<HTMLButtonElement>('[data-gp-template]');
  const colorOptions = modal.element.querySelectorAll<HTMLButtonElement>('[data-gp-color]');
  colorOptions.forEach((option) => {
    option.addEventListener('click', () => {
      modalSelectedColor = option.dataset.gpColor!;
      syncModalColorSelection();
      updateIconButton();
    }, { signal: lifecycleController.signal });
  });

  function renderModalIcons() {
    iconStyleInputs.forEach((input) => { input.checked = input.value === modalIconStyle; });
    iconOptions.forEach((option) => {
      option.innerHTML = renderIconSvg(option.dataset.gpTemplate as ProjectIcon, modalIconStyle);
    });
    updateIconButton();
  }

  modal.element.addEventListener('change', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.name !== 'gp-project-icon-style' || !isProjectIconStyle(input.value)) return;
    modalIconStyle = input.value;
    renderModalIcons();
  }, { signal: lifecycleController.signal });

  function render(state: RuntimeState) {
    currentState = state;
    const signature = JSON.stringify([
      state.projects, [...state.chatIndex.values()],
      [...state.nativeConversationIds], state.nativeChatsReady,
      state.activeConversationId
    ]);
    const pinChanged = state.projects.some((project) =>
      pinnedSnapshot.has(project.id) && pinnedSnapshot.get(project.id) !== (project.isPinned === true)
    );
    const previousRects = new Map<string, DOMRect>();
    if (pinChanged && shouldAnimateMotion()) {
      panelRoot.querySelectorAll<HTMLElement>('.gp-project').forEach((project) => {
        previousRects.set(project.dataset.gpProjectId!, project.getBoundingClientRect());
      });
    }
    // 仅折叠状态变化时保留节点，避免打断过渡或丢失键盘焦点。
    if (signature !== structureSignature) {
      panelRoot.innerHTML = buildPanelMarkup(state, currentSyncStatus);
      structureSignature = signature;
    }
    syncHeaderIndicator();
    setPanelCollapsed(state.uiPrefs.projectsCollapsed);
    panelRoot.querySelectorAll<HTMLElement>('.gp-project').forEach((project) => {
      const expanded = state.expandedProjectIds.has(project.dataset.gpProjectId!);
      const toggle = project.querySelector<HTMLElement>('[data-gp-action="toggle-project"]');
      const content = project.querySelector<HTMLElement>('.gp-project-collapse');
      toggle?.classList.toggle('active', expanded);
      toggle?.setAttribute('aria-expanded', String(expanded));
      if (content) {
        content.toggleAttribute('data-gp-motion-instant', !shouldAnimateMotion());
        content.classList.toggle('collapsed', !expanded);
        content.inert = !expanded;
      }
      const previous = previousRects.get(project.dataset.gpProjectId!);
      if (previous) {
        const distance = previous.top - project.getBoundingClientRect().top;
        if (Math.abs(distance) > 1) project.animate([
          { transform: `translateY(${distance}px)` }, { transform: 'translateY(0)' }
        ], { duration: 180, easing: MOTION_EASE });
      }
    });
    pinnedSnapshot = new Map(state.projects.map((project) => [project.id, project.isPinned === true]));
    attachPanelEvents(state);
  }

  function attachPanelEvents(state: RuntimeState) {
    panelEventsController?.abort();
    panelEventsController = new AbortController();

    panelRoot.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      const sectionMenuButton = target.closest<HTMLButtonElement>('[data-gp-action="section-menu"]');
      if (sectionMenuButton) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        projectMenu.close();
        chatMenu.close();
        if (sectionMenu.isOpen()) {
          sectionMenu.close(true);
        } else {
          openSectionMenu(sectionMenuButton);
        }
        return;
      }

      const chatMenuButton = target.closest<HTMLButtonElement>('[data-gp-action="chat-menu"]');
      if (chatMenuButton) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        sectionMenu.close();
        projectMenu.close();
        const chatRow = chatMenuButton.closest<HTMLElement>('[data-gp-chat-id]');
        if (!chatRow) return;
        const chatId = chatRow.dataset.gpChatId as string;
        const chatProjectId = chatRow.dataset.gpProjectId as string;
        const project = state.projects.find((p) => p.id === chatProjectId);
        if (project) {
          chatMenu.open(
            chatMenuButton,
            chatProjectId,
            project.name,
            {
              onRemove: () => options.onRemoveChatFromProject(chatId).catch(showMoveError),
              onMoveToProject: (targetProjectId) => options.onMoveChatToProject(chatId, targetProjectId).catch(showMoveError)
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
        sectionMenu.close();
        chatMenu.close();
        const projectRow = projectMenuButton.closest<HTMLElement>('[data-gp-project-id]');
        const projectId = projectRow?.dataset.gpProjectId;
        const project = state.projects.find((item) => item.id === projectId);
        if (project) {
          openProjectMenu(project, projectMenuButton);
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
        const nextCollapsed = !state.uiPrefs.projectsCollapsed;
        options.onToggleCollapse(nextCollapsed);
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

    panelRoot.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const target = event.target as HTMLElement;
      if (target.matches('[data-gp-action="toggle-section"], [data-gp-action="new-project"], [data-gp-action="toggle-project"]')) {
        event.preventDefault();
        target.click();
      }
    }, { signal: panelEventsController.signal });

    panelRoot.addEventListener('dragstart', (event) => {
      const target = event.target as HTMLElement | null;
      const chatRow = target?.closest<HTMLElement>('[data-gp-chat-id]');
      if (!chatRow || target?.closest('[data-gp-action="chat-menu"]')) return;
      const conversationId = chatRow.dataset.gpChatId;
      const sourceProjectId = chatRow.dataset.gpProjectId || null;
      if (!conversationId) return;

      setActiveDraggedChat({ conversationId, sourceProjectId });
      chatRow.classList.add('gp-dragging');
      if (event.dataTransfer) {
        event.dataTransfer.setData('application/x-gemini-chat-id', conversationId);
        event.dataTransfer.effectAllowed = 'move';
      }
    }, { signal: panelEventsController.signal });

    panelRoot.addEventListener('dragover', (event) => {
      const dragged = getActiveDraggedChat();
      if (!dragged) return;
      const target = event.target as HTMLElement | null;
      const projectEl = target?.closest<HTMLElement>('.gp-project');
      const targetProjectId = projectEl?.dataset.gpProjectId;
      if (!projectEl || !targetProjectId || targetProjectId === dragged.sourceProjectId) {
        clearDropTargets();
        return;
      }

      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      const row = projectEl.querySelector<HTMLElement>('.gp-project-row');
      if (row && !row.classList.contains('gp-drop-target')) {
        clearDropTargets();
        row.classList.add('gp-drop-target');
      }
    }, { signal: panelEventsController.signal });

    panelRoot.addEventListener('dragleave', (event) => {
      const target = event.target as HTMLElement | null;
      const projectEl = target?.closest<HTMLElement>('.gp-project');
      const related = event.relatedTarget as Node | null;
      if (!projectEl || !related || !projectEl.contains(related)) {
        projectEl?.querySelector<HTMLElement>('.gp-project-row')?.classList.remove('gp-drop-target');
      }
    }, { signal: panelEventsController.signal });

    panelRoot.addEventListener('drop', (event) => {
      const dragged = getActiveDraggedChat();
      clearDragFeedback();
      if (!dragged) return;
      const target = event.target as HTMLElement | null;
      const targetProjectId = target?.closest<HTMLElement>('.gp-project')?.dataset.gpProjectId;
      if (!targetProjectId || targetProjectId === dragged.sourceProjectId) return;

      event.preventDefault();
      clearActiveDraggedChat();
      const targetProject = state.projects.find((item) => item.id === targetProjectId);
      void options.onMoveChatToProject(dragged.conversationId, targetProjectId)
        .then(() => { if (targetProject) showToast(`Moved to ${targetProject.name}`); })
        .catch(showMoveError);
    }, { signal: panelEventsController.signal });
  }

  function clearDropTargets() {
    panelRoot.querySelectorAll('.gp-drop-target').forEach((node) => node.classList.remove('gp-drop-target'));
  }

  function clearDragFeedback() {
    clearDropTargets();
    panelRoot.querySelectorAll('.gp-dragging').forEach((node) => node.classList.remove('gp-dragging'));
  }

  function showMoveError(error: unknown) {
    console.warn('[Gemini Projects] Could not move chat', error);
    showToast('Could not move chat. Please try again.');
  }

  function openCreateModal() {
    if (modal.isSaving()) return;
    modalMode = 'create';
    modalProjectId = null;
    modalSelectedIcon = 'default';
    modalIconStyle = DEFAULT_PROJECT_ICON_STYLE;
    modalSelectedColor = MULTICOLOR;
    showModal({
      title: 'Create Project',
      confirmLabel: 'Done',
      name: '',
      showIcons: true
    });
  }

  function openEditModal(project: Project) {
    if (modal.isSaving()) return;
    modalMode = 'edit';
    modalProjectId = project.id;
    modalProject = project;
    modalSelectedIcon = project.icon;
    modalIconStyle = project.iconStyle;
    modalSelectedColor = project.useIconPalette ? MULTICOLOR : project.color ?? ADAPTIVE_PROJECT_COLOR;
    showModal({
      title: 'Edit Project',
      confirmLabel: 'Save',
      name: project.name,
      showIcons: true
    });
  }

  function getModalIconColor(): string {
    return modalSelectedColor === MULTICOLOR ? getPaletteIconColor(modalSelectedIcon) : modalSelectedColor;
  }

  function updateIconButton() {
    if (iconButton) {
      iconButton.innerHTML = renderIconSvg(modalSelectedIcon, modalIconStyle, getModalIconColor());
    }
  }

  function setPanelCollapsed(collapsed: boolean) {
    const title = panelRoot.querySelector<HTMLElement>('[data-gp-action="toggle-section"]');
    const container = panelRoot.querySelector<HTMLElement>('[data-gp-list-container]');
    title?.classList.toggle('collapsed', collapsed);
    title?.setAttribute('aria-expanded', String(!collapsed));
    container?.toggleAttribute('data-gp-motion-instant', !shouldAnimateMotion());
    title?.toggleAttribute('data-gp-motion-instant', !shouldAnimateMotion());
    container?.classList.toggle('collapsed', collapsed);
    if (container) container.inert = collapsed;
  }

  function syncModalIconSelection() {
    iconOptions.forEach((option) => {
      const isSelected = option.dataset.gpTemplate === modalSelectedIcon;
      option.classList.toggle('selected', isSelected);
      option.setAttribute('aria-pressed', String(isSelected));
    });
  }

  function syncModalColorSelection() {
    modal.element.toggleAttribute('data-gp-icon-palette', modalSelectedColor === MULTICOLOR);
    const color = resolveProjectIconColor(modalSelectedColor);
    modal.element.style.setProperty('--gp-grid-icon-color', color ?? '');
    const selection = modalSelectedColor.toLowerCase();
    colorOptions.forEach((option) => {
      const isSelected = option.dataset.gpColor!.toLowerCase() === selection;
      option.classList.toggle('selected', isSelected);
      option.setAttribute('aria-pressed', String(isSelected));
    });
  }

  function createProjectFromTemplate(
    templateName: string,
    templateIcon: ProjectIcon,
    input?: HTMLInputElement,
    confirm?: HTMLButtonElement,
    focusInput = false
  ) {
    modalSelectedIcon = templateIcon;
    updateIconButton();
    syncModalIconSelection();
    if (modalMode === 'create' && !inputDirty && input) {
      input.value = templateName;
      if (focusInput) {
        input.focus({ preventScroll: true });
        input.select();
      }
    }
    if (confirm && input) {
      confirm.disabled = input.value.trim().length === 0;
    }
  }

  function showModal(config: { title: string; confirmLabel: string; name: string; showIcons: boolean }) {
    if (modal.isSaving()) return;
    const editingId = modalProjectId;
    const saveMode = modalMode;
    const draftId = editingId || crypto.randomUUID();
    modal.open(config, () => {
      const project = Array.from(panelRoot.querySelectorAll<HTMLElement>('.gp-project'))
        .find((row) => row.dataset.gpProjectId === editingId);
      const target = project?.querySelector<HTMLElement>('[data-gp-action="project-menu"]')
        || panelRoot.querySelector<HTMLElement>('[data-gp-action="new-project"]');
      return target?.closest('[inert]')
        ? panelRoot.querySelector<HTMLElement>('[data-gp-action="toggle-section"]') : target;
    });
    inputDirty = false;
    const input = modal.element.querySelector<HTMLInputElement>('[data-gp-name-input]');
    const confirm = modal.element.querySelector<HTMLButtonElement>('[data-gp-action="confirm"]');
    const cancelButton = modal.element.querySelector<HTMLButtonElement>('[data-gp-action="cancel"]');
    const iconRow = modal.element.querySelector<HTMLElement>('[data-gp-template-row]');
    iconButton = modal.element.querySelector<HTMLButtonElement>('[data-gp-current-icon]');

    if (input) {
      input.value = config.name;
      input.focus();
    }

    if (iconRow) {
      iconRow.style.display = config.showIcons ? 'flex' : 'none';
    }

    confirm!.textContent = config.confirmLabel;
    confirm!.disabled = input?.value.trim().length === 0;
    renderModalIcons();
    syncModalIconSelection();
    syncModalColorSelection();

    if (input) {
      input.oninput = () => {
        inputDirty = true;
        confirm!.disabled = input.value.trim().length === 0;
      };
    }

    confirm!.onclick = async () => {
      if (modal.isSaving()) return;
      const name = input?.value.trim() ?? '';
      if (!name) {
        return;
      }

      const now = Date.now();
      const projectData: Project = {
        id: draftId,
        name,
        icon: modalSelectedIcon,
        iconStyle: modalIconStyle,
        color: getModalIconColor(),
        useIconPalette: modalSelectedColor === MULTICOLOR || undefined,
        isPinned: modalMode === 'edit' ? modalProject?.isPinned === true : false,
        createdAt: modalMode === 'create' ? now : (modalProject?.createdAt || now),
        updatedAt: now,
        sortIndex: modalMode === 'create' ? now : (modalProject?.sortIndex || now)
      };

      modal.setError('');
      modal.setSaving(true);
      try {
        await options.onSaveProject(projectData, modalMode === 'edit');
        modal.setSaving(false);
        modal.close();
        showToast(saveMode === 'create' ? 'Project created' : 'Project saved');
      } catch (error) {
        console.error('[Gemini Projects] Could not save project', error);
        modal.setSaving(false);
        modal.setError('Could not save this project. Your changes are still here. Please try again.');
        input?.focus();
      }
    };

    if (cancelButton) {
      cancelButton.onclick = () => modal.close();
    }

    iconOptions.forEach((chip) => {
      chip.onclick = (event) => {
        const iconId = chip.dataset.gpTemplate as ProjectIcon;
        const label = chip.dataset.gpTemplateLabel || getIconLabel(iconId);
        // 仅鼠标点击模板图标时将焦点移回名称框并选中默认名，保留键盘 Tab 遍历图标网格的体验。
        createProjectFromTemplate(label, iconId, input ?? undefined, confirm ?? undefined, event.detail > 0);
      };
    });
  }

  function openProjectMenu(project: Project, anchor: HTMLButtonElement) {
    projectMenu.open(anchor, project, {
      onReturnFocus: () => {
        const row = panelRoot.querySelector(`.gp-project[data-gp-project-id="${CSS.escape(project.id)}"]`);
        const target = row?.querySelector<HTMLElement>('[data-gp-action="project-menu"]') ??
          panelRoot.querySelector<HTMLElement>('[data-gp-action="new-project"]');
        target?.focus({ preventScroll: true });
      },
      onTogglePin: async () => {
        const isPinned = !project.isPinned;
        await options.onToggleProjectPin(project.id, isPinned);
        showToast(isPinned ? 'Project pinned' : 'Project unpinned');
      },
      onPinError: (error) => {
        console.warn('[Gemini Projects] Pin update failed', error);
        showToast('Could not update project pin. Please try again.');
      },
      onEdit: () => openEditModal(project),
      onDelete: () => options.onDeleteProject(project.id)
    });
  }

  function showToast(message: string) {
    if (!lifecycleController.signal.aborted) toast.show(message);
  }

  async function handleBackupClick() {
    try {
      await exportAllData();
    } catch (error) {
      console.error('[Gemini Projects] Backup failed', error);
      showToast('Backup failed. Please try again.');
    }
  }

  function handleRestoreClick() {
    triggerImport((result) => showToast(result.message));
  }

  function syncHeaderIndicator() {
    const button = panelRoot.querySelector<HTMLButtonElement>('[data-gp-action="section-menu"]');
    if (!button) return;
    const warning = getSyncWarningTitle(currentSyncStatus);
    button.classList.toggle('has-alert', warning !== null);
    if (warning) button.title = warning;
    else button.removeAttribute('title');
    const dot = button.querySelector<HTMLElement>('.gp-sync-dot');
    dot?.classList.toggle('visible', warning !== null);
  }

  function setSyncStatus(status: CloudSyncStatus) {
    currentSyncStatus = status;
    syncHeaderIndicator();
    sectionMenu.update(currentSyncStatus);
  }

  function openSectionMenu(anchor: HTMLButtonElement) {
    sectionMenu.open(anchor, currentSyncStatus, {
      onReturnFocus: () => {
        panelRoot.querySelector<HTMLElement>('[data-gp-action="section-menu"]')?.focus({ preventScroll: true });
      },
      onSyncNow: async () => {
        const next = await options.onSyncNow();
        setSyncStatus(next);
        showToast('Synced with Google Drive');
      },
      onConnectGoogleDrive: async () => {
        const wasConnected = currentSyncStatus.enabled;
        const next = await options.onConnectGoogleDrive();
        setSyncStatus(next);
        showToast(wasConnected ? 'Reconnected to Google Drive' : 'Connected to Google Drive');
      },
      onDisconnectGoogleDrive: async () => {
        const next = await options.onDisconnectGoogleDrive();
        setSyncStatus(next);
        showToast('Disconnected from Google Drive');
      },
      onSyncError: (error) => {
        console.warn('[Gemini Projects] Sync failed', error);
        const message = error instanceof Error && error.message
          ? error.message
          : 'Sync failed. Please try again.';
        showToast(message);
      },
      onBackup: () => {
        void handleBackupClick();
      },
      onRestore: () => handleRestoreClick()
    });
  }

  function closeAllOverlays() {
    modal.close();
    projectMenu.close();
    sectionMenu.close();
    chatMenu.close();
    toast.hide();
  }

  function destroy() {
    clearDragFeedback();
    closeAllOverlays();
    overlayLayer.replaceChildren();
    panelEventsController?.abort();
    panelEventsController = null;
    lifecycleController.abort();
    stopThemeObserver();
  }

  return {
    render,
    setSyncStatus,
    closeAllOverlays,
    showToast,
    clearDragFeedback,
    openCreateModal,
    destroy
  };
}

export function renderProjectsSection(
  projects: Project[],
  chatIndex: Map<string, ChatRef>,
  expandedProjectIds: Set<string>,
  nativeConversationIds: Set<string> = new Set(),
  nativeChatsReady = false,
  activeConversationId: string | null = null
): string {
  const sorted = [...projects].sort((a, b) =>
    Number(b.isPinned === true) - Number(a.isPinned === true) || a.sortIndex - b.sortIndex
  );
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

      const chatRows = `
          <div class="gp-project-chats" style="--gp-project-color: ${escapeAttr(accentColor)};">
            ${chats.length
          ? chats
            .map(
              (chat) => {
                const isActive = activeConversationId !== null && chat.conversationId === activeConversationId;
                const isMissing = nativeChatsReady && !isActive && !nativeConversationIds.has(chat.conversationId);
                return `
                        <div class="gp-chat-row ${isActive ? 'active' : ''} ${isMissing ? 'missing' : ''}" draggable="true" data-gp-chat-id="${escapeAttr(chat.conversationId)}" data-gp-project-id="${escapeAttr(project.id)}">
                          <a class="gp-chat-link" draggable="false" href="${escapeHtml(chat.lastUrl || `/app/${chat.conversationId}`)}" ${isMissing ? 'title="Not in currently loaded history — click to open"' : ''}>
                            <span class="gp-chat-color" aria-hidden="true"></span>
                            <span class="gp-chat-title">${escapeHtml(chat.title || 'Untitled chat')}</span>
                            ${isMissing ? '<span class="gp-chat-missing">Missing</span>' : ''}
                          </a>
                          <button class="gp-chat-kebab" draggable="false" data-gp-action="chat-menu" aria-label="Chat menu">${renderUiIcon('moreVertical', 18)}</button>
                        </div>
                      `
              }
            )
            .join('')
          : '<div class="gp-chat-empty">No chats yet</div>'
        }
          </div>
        `;

      return `
        <div class="gp-project" data-gp-project-id="${escapeAttr(project.id)}">
          <div class="gp-row gp-project-row ${isExpanded ? 'active' : ''}" data-gp-action="toggle-project" role="button" tabindex="0" aria-label="${escapeAttr(project.name)}" aria-expanded="${isExpanded}">
            <span class="gp-icon">${renderIconSvg(project.icon, project.iconStyle, project.color)}</span>
            <span class="gp-label">${escapeHtml(project.name)}</span>
            ${project.isPinned ? `<span class="gp-project-pin" role="img" aria-label="Pinned project" title="Pinned project">${renderProjectActionIcon('pin')}</span>` : ''}
            <span class="gp-row-trailing">
              ${chats.length > 0 ? `<span class="gp-project-count" aria-hidden="true">${chats.length}</span>` : ''}
              <button class="gp-kebab" data-gp-action="project-menu" aria-label="Project menu">${renderUiIcon('moreVertical', 20)}</button>
            </span>
          </div>
          <div class="gp-project-collapse ${isExpanded ? '' : 'collapsed'}" ${isExpanded ? '' : 'inert'}>
            ${chatRows}
          </div>
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
      ${RADIUS_TOKENS_CSS}
      :host {
        all: initial;
        color: var(--gp-fg, #1f1f1f);
        box-sizing: border-box;

        /* Native Fonts & Colors (Gemini) */
        --gp-font: "Google Sans Flex", "Google Sans", "Helvetica Neue", sans-serif;
        --gp-fg: #1f1f1f;
        --gp-fg-muted: #5f6368;
        --gp-section: rgba(0, 0, 0, 0.54);
        --gp-bg-hover: rgba(31, 31, 31, 0.06); 
        --gp-bg-active: #f1f3f4;

        --gp-spacing-row: 0px;

        display: block;
        width: 100%;
        pointer-events: auto;
        position: relative;
        isolation: isolate;
        padding-top: 8px;
      }

      #gp-panel-root { font-family: var(--gp-font); }

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

      .gp-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 4px;
      }

      .gp-title {
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: 6px;
        margin: 0;
        padding: 0 8px 0 14px;
        height: 32px;
        color: var(--gp-section);
        font-family: var(--gp-font);
        font-size: 13px;
        font-weight: 400;
        line-height: 17px;
        cursor: pointer;
        user-select: none;
        border-radius: var(--gp-radius-pill);
        transition: background 0.1s ease;
      }

      .gp-header-menu {
        position: relative;
        width: 28px;
        height: 28px;
        margin-right: 2px;
        border-radius: var(--gp-radius-circle);
        border: none;
        background: transparent;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--gp-section);
        cursor: pointer;
        opacity: 0.72;
        transition: background 0.15s ease, color 0.15s ease, opacity 0.15s ease;
        flex-shrink: 0;
      }

      .gp-header-menu svg {
        width: 18px;
        height: 18px;
      }

      .gp-header:hover .gp-header-menu,
      .gp-header-menu:hover,
      .gp-header-menu:focus-visible,
      .gp-header-menu[aria-expanded="true"],
      .gp-header-menu.has-alert {
        opacity: 1;
      }

      .gp-header-menu:hover {
        background: var(--gp-bg-hover);
        color: var(--gp-fg);
      }

      .gp-sync-dot {
        position: absolute;
        top: 4px;
        right: 4px;
        width: 6px;
        height: 6px;
        border-radius: var(--gp-radius-circle);
        background: #b5653f;
        display: none;
        pointer-events: none;
      }

      :host(.dark) .gp-sync-dot {
        background: #e0a28b;
      }

      .gp-sync-dot.visible {
        display: block;
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
        transition: transform ${PANEL_COLLAPSE_ANIMATION_MS}ms cubic-bezier(0.2, 0, 0, 1);
        color: var(--gp-fg-muted);
        opacity: 0.82;
      }

      .gp-chevron svg {
        width: 18px;
        height: 18px;
        fill: none;
        display: block;
      }

      .gp-title.collapsed .gp-chevron {
        transform: rotate(-90deg);
      }

      .gp-list-container {
        display: grid;
        grid-template-rows: 1fr;
        overflow: hidden;
        opacity: 1;
        transition:
          grid-template-rows ${PANEL_COLLAPSE_ANIMATION_MS}ms cubic-bezier(0.2, 0, 0, 1),
          opacity 120ms ease;
      }

      .gp-list-container.collapsed {
        grid-template-rows: 0fr;
        opacity: 0;
      }

      .gp-list-content {
        min-height: 0;
        /* 折叠只裁切内容，避免 flex 将行高从 32px 挤到图标的最小高度。 */
        display: block;
        overflow: hidden;
      }

      .gp-project-collapse {
        display: grid;
        grid-template-rows: 1fr;
        opacity: 1;
        transition: grid-template-rows ${PROJECT_COLLAPSE_ANIMATION_MS}ms var(--gp-motion-ease),
                    opacity ${PROJECT_COLLAPSE_ANIMATION_MS}ms var(--gp-motion-ease);
      }
      .gp-project-collapse.collapsed { grid-template-rows: 0fr; opacity: 0; }
      .gp-project-collapse > .gp-project-chats { min-height: 0; overflow: hidden; }
      .gp-title:focus-visible, .gp-header-menu:focus-visible, .gp-row:focus-visible,
      .gp-kebab:focus-visible, .gp-chat-kebab:focus-visible, .gp-chat-link:focus-visible {
        outline: 2px solid var(--gp-fg-muted); outline-offset: -2px;
      }
      [data-gp-motion-instant], [data-gp-motion-instant] .gp-chevron { transition: none !important; }
      @media (prefers-reduced-motion: reduce) {
        .gp-project-collapse, .gp-list-container, .gp-chevron { transition: none; }
      }

      .gp-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0 0 0 6px;
        padding: 0 8px;
        width: calc(100% - 6px);
        height: 32px;
        border-radius: var(--gp-radius-pill);
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

      .gp-row:hover, .gp-row:focus-within {
        background: var(--gp-bg-hover);
      }

      .gp-row.gp-force-hover {
        background: var(--gp-bg-hover);
      }

      .gp-row.gp-drop-target {
        background: var(--gp-bg-active);
        box-shadow: inset 0 0 0 1.5px var(--gp-fg-muted);
      }

      .gp-chat-row.gp-dragging {
        opacity: 0.45;
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
        color: var(--gp-fg-muted);
      }

      .gp-project-pin {
        display: flex;
        align-items: center;
        flex-shrink: 0;
        color: var(--gp-fg-muted);
      }
      .gp-project-pin svg {
        width: 14px;
        height: 14px;
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

      .gp-row-trailing {
        position: relative;
        width: 32px;
        height: 32px;
        margin-right: -8px;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .gp-project-count {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        color: var(--gp-section);
        opacity: 1;
        transition: opacity 0.15s ease;
        pointer-events: none;
      }

      .gp-row:focus-within .gp-project-count,
      .gp-row:hover .gp-project-count,
      .gp-row.gp-force-hover .gp-project-count {
        opacity: 0;
      }

      .gp-kebab {
        width: 32px;
        height: 32px;
        border-radius: var(--gp-radius-circle);
        border: none;
        background: transparent;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--gp-fg-muted);
        cursor: pointer;
        opacity: 0;
        transition: background 0.15s ease, opacity 0.15s ease;
        flex-shrink: 0;
      }

      .gp-kebab svg {
        width: 20px;
        height: 20px;
      }

      .gp-row:focus-within .gp-kebab,
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
        border-radius: var(--gp-radius-pill);
        transition: background 0.1s;
        pointer-events: auto;
      }

      .gp-chat-row:hover {
        background: var(--gp-bg-hover);
      }

      .gp-chat-row.active {
        background: var(--gp-bg-active);
        color: var(--gp-fg);
        font-weight: 500;
      }

      .gp-chat-row.active .gp-chat-link {
        color: var(--gp-fg);
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
        border-radius: var(--gp-radius-pill);
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
        border-radius: var(--gp-radius-circle);
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
        border-radius: var(--gp-radius-pill);
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
        border-radius: var(--gp-radius-circle);
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

      .gp-chat-row:focus-within .gp-chat-kebab,
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

function getSyncWarningTitle(status: CloudSyncStatus): string | null {
  if (!status.enabled) return null;
  if (status.state === 'auth_expired') {
    return 'Google Drive session expired. Click to reconnect.';
  }
  if (status.state === 'error') {
    return status.lastError || 'Google Drive sync error';
  }
  return null;
}

function formatDriveStatusLabel(status: CloudSyncStatus): string {
  if (!status.available || status.state === 'unavailable') return 'Unavailable';
  if (status.state === 'syncing') return 'Syncing…';
  if (status.state === 'auth_expired') return 'Reconnect needed';
  if (status.state === 'error') return 'Error';
  return 'Synced';
}

function buildPanelMarkup(state: RuntimeState, syncStatus: CloudSyncStatus): string {
  const collapsed = state.uiPrefs.projectsCollapsed;
  const chevronSvg = renderUiIcon('chevronDown', 18);
  const warningTitle = getSyncWarningTitle(syncStatus);

  return `
    <div class="gp-panel">
      <!-- Header with Chevron and Section Options -->
      <div class="gp-header">
        <div class="gp-title ${collapsed ? 'collapsed' : ''}" data-gp-action="toggle-section" tabindex="0" role="button" aria-expanded="${String(!collapsed)}">
          <span>Projects</span>
          <span class="gp-chevron">${chevronSvg}</span>
        </div>
        <button class="gp-header-menu${warningTitle ? ' has-alert' : ''}" type="button" data-gp-action="section-menu" aria-label="Projects options" aria-haspopup="menu" aria-expanded="false"${warningTitle ? ` title="${escapeAttr(warningTitle)}"` : ''}>
          ${renderUiIcon('moreVertical', 18)}
          <span class="gp-sync-dot${warningTitle ? ' visible' : ''}" aria-hidden="true"></span>
        </button>
      </div>

      <!-- Collapsible Container -->
      <div class="gp-list-container ${collapsed ? 'collapsed' : ''}" data-gp-list-container>
        <div class="gp-list-content">
          <div class="gp-row gp-new" data-gp-action="new-project" role="button" tabindex="0">
            <span class="gp-icon">${renderUiIcon('plus', 20)}</span>
            <span class="gp-label">New Project</span>
          </div>
          ${renderProjectsSection(
    state.projects,
    state.chatIndex,
    state.expandedProjectIds,
    state.nativeConversationIds,
    state.nativeChatsReady,
    state.activeConversationId
  )}
        </div>
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
      <span class="gp-icon-button" data-gp-current-icon aria-hidden="true"></span>
      <input class="gp-name-input" data-gp-name-input type="text" placeholder="Project name" aria-label="Project name" />
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
      ${SURFACE_THEME_CSS}
      ${PROJECT_ICON_STYLE_CSS}
      :host {
        all: initial;
        color-scheme: light;
        color: var(--gp-fg);
        --gp-font: var(--gp-font-sans);
        --gp-fg-muted: var(--gp-fg-secondary);
        --gp-muted: var(--gp-fg-tertiary);
        --gp-hover: var(--gp-bg-hover);
        --gp-hover-strong: var(--gp-bg-active);
        --gp-selected: var(--gp-surface-selected);
        --gp-chip-idle-opacity: .68;
        --gp-chip-hover-bg: var(--gp-surface-footer);
        --gp-selected-pillow-shadow: inset 0 1px 2px rgb(20 20 19 / .04);
        --gp-on-accent: var(--gp-accent-fg);
        --gp-name-inset: 4px;
      }
      :host(.dark), :host([data-gp-theme="dark"]) {
        --gp-chip-idle-opacity: .62;
        --gp-chip-hover-bg: #333330;
        --gp-selected-pillow-shadow: inset 0 1px 0 rgb(255 255 255 / .08);
      }

      .gp-modal-backdrop {
        position: fixed;
        inset: 0;
        background: var(--gp-backdrop);
        backdrop-filter: var(--gp-backdrop-blur);
        display: none;
        align-items: center;
        justify-content: center;
        pointer-events: auto;
      }
      .gp-modal {
        --gp-icon-columns: 10;
        --gp-action-width: 124px;
        --gp-action-height: var(--gp-project-action-height);
        --gp-panel-inset: 24px;
        background: var(--gp-surface);
        box-sizing: border-box;
        width: 600px;
        max-width: calc(100vw - 32px);
        max-height: calc(100dvh - 32px);
        box-shadow: var(--gp-shadow);
        border: .5px solid var(--gp-border);
        border-radius: var(--gp-radius-project-modal);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        font: 14px/1.4 var(--gp-font);
        color: var(--gp-fg);
        position: relative;
      }
      .gp-modal-body {
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-width: thin;
        padding: 20px var(--gp-panel-inset) 22px;
        display: flex;
        flex-direction: column;
        gap: 20px;
      }
      .gp-modal-body > * { flex-shrink: 0; }
      .gp-modal-header, .gp-modal-actions { flex-shrink: 0; }
      .gp-modal,
      .gp-modal * {
        box-sizing: border-box;
      }
      .gp-form-status { margin: 0; font: 13px/1.5 var(--gp-font); color: var(--gp-danger); }
      .gp-form-status:empty { display: none; }
      .gp-modal[aria-busy="true"] { cursor: progress; }
      .gp-modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 18px 18px 0 var(--gp-panel-inset);
        width: 100%;
        font-size: 19px;
        font-weight: 800;
        font-family: var(--gp-font);
        letter-spacing: 0.01em;
        color: var(--gp-fg);
      }
      .gp-modal-header [data-gp-modal-title] {
        ${PANEL_TITLE_TYPOGRAPHY}
        margin: 0;
        font-style: normal;
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
        flex: 0 0 32px;
        border-radius: var(--gp-radius-circle);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        margin-right: 0;
        transition: background var(--gp-transition);
      }
      .gp-modal-close svg { width: 18px; height: 18px; }
      .gp-modal-close:hover { background: var(--gp-hover); }
      .gp-namebox {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        border: 1px solid var(--gp-control-border);
        border-radius: var(--gp-radius-pill);
        padding: var(--gp-name-inset) 16px var(--gp-name-inset) var(--gp-name-inset);
        position: relative;
        background: var(--gp-surface-sunken);
        transition: background-color var(--gp-transition), border-color var(--gp-transition), box-shadow var(--gp-transition);
      }
      .gp-namebox:focus-within {
        background: var(--gp-input-focus-bg);
        border-color: var(--gp-input-focus-border);
        box-shadow: var(--gp-input-focus-shadow);
      }
      .gp-icon-button {
        width: 38px;
        height: 38px;
        border: none;
        border-radius: var(--gp-radius-circle);
        background: transparent;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: default;
        color: var(--gp-fg);
        flex: 0 0 38px;
      }
      .gp-icon-button svg {
        width: 22px;
        height: 22px;
        stroke-width: 1.8;
      }
      .gp-name-input {
        flex: 1;
        min-width: 0;
        border: none;
        outline: none;
        background: transparent;
        font-size: 14px;
        color: var(--gp-fg);
        font-family: var(--gp-font);
      }
      .gp-name-input::placeholder { color: var(--gp-muted); }
      .gp-template-row {
        display: flex;
        flex-direction: column;
        gap: 12px;
        width: 100%;
      }
      .gp-template-grid {
        display: grid;
        grid-template-columns: repeat(var(--gp-icon-columns), minmax(0, 1fr));
        gap: 8px;
        width: 100%;
      }
      .gp-template-chip {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        min-width: 0;
        aspect-ratio: 1;
        min-height: 36px;
        padding: 0;
        border-radius: var(--gp-radius-pill);
        border: 0;
        cursor: pointer;
        color: var(--gp-fg);
        background: transparent;
        transition: background-color var(--gp-transition), box-shadow var(--gp-transition);
        flex: 0 0 auto;
      }
      .gp-template-chip:hover {
        background: var(--gp-chip-hover-bg);
      }
      .gp-template-chip:active { transform: translateY(0); }
      .gp-template-chip.selected {
        background: var(--gp-selected);
        color: var(--gp-fg);
        box-shadow: var(--gp-selected-pillow-shadow);
        border-radius: var(--gp-radius-pill);
      }
      .gp-template-chip svg {
        width: 24px;
        height: 24px;
        stroke-width: 1.8;
        opacity: var(--gp-chip-idle-opacity);
        transition: opacity var(--gp-transition), transform var(--gp-transition);
      }
      .gp-template-chip:hover svg {
        opacity: .95;
      }
      .gp-template-chip.selected svg {
        opacity: 1;
        transform: scale(1.06);
      }
      .gp-template-chip:focus-visible, .gp-color-dot:focus-visible, .gp-modal-close:focus-visible, .gp-tool-button:focus-visible, .gp-primary:focus-visible { outline: 2px solid var(--gp-focus); outline-offset: 2px; }

      .gp-color-row {
        display: grid;
        grid-template-columns: repeat(${COLOR_OPTIONS.length + 1}, minmax(0, 1fr));
        gap: 2px;
        width: min(302px, 100%);
      }
      .gp-color-dot {
        width: 100%;
        aspect-ratio: 1;
        border-radius: var(--gp-radius-circle);
        border: 0;
        background: transparent;
        cursor: pointer;
        padding: 0;
        position: relative;
        transition: background-color var(--gp-transition), box-shadow var(--gp-transition);
      }
      .gp-color-dot::before {
        content: '';
        position: absolute;
        inset: 6px;
        border-radius: var(--gp-radius-circle);
        background: var(--gp-choice-color);
        opacity: .56;
        transform: scale(.86);
        transition: opacity var(--gp-transition), transform var(--gp-transition), box-shadow var(--gp-transition);
      }
      .gp-color-dot:hover { background: var(--gp-chip-hover-bg); }
      .gp-color-dot:hover::before { opacity: .92; transform: scale(.96); }
      .gp-color-dot.selected {
        background: var(--gp-selected);
        box-shadow: var(--gp-selected-pillow-shadow);
      }
      .gp-color-dot.selected::before {
        opacity: 1;
        transform: scale(1);
        box-shadow: 0 1px 3px rgb(20 20 19 / .16);
      }
      .gp-color-adaptive { --gp-choice-color: var(--gp-fg); }
      .gp-color-multicolor {
        --gp-choice-color: conic-gradient(${MULTICOLOR_ICON_PALETTE.map((color, index) => {
          const step = 1 / MULTICOLOR_ICON_PALETTE.length;
          return `${color} ${index * step}turn ${(index + 1) * step}turn`;
        }).join(', ')});
      }

      .gp-modal-actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
        padding: var(--gp-project-footer-inset);
        border-top: 1px solid var(--gp-border);
        background: var(--gp-surface-footer);
      }
      .gp-primary,
      .gp-tool-button {
        min-width: 92px;
        height: var(--gp-action-height);
        border-radius: var(--gp-radius-pill);
        font-family: var(--gp-font);
        letter-spacing: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        box-shadow: none;
        -webkit-font-smoothing: antialiased;
        -webkit-text-stroke: 0 transparent;
        text-shadow: none;
        paint-order: normal;
      }
      .gp-tool-button {
        padding: 0 12px;
        border: 1px solid var(--gp-border);
        background: transparent;
        color: var(--gp-fg-secondary);
        font-size: 13px;
        font-weight: 500;
        gap: 9px;
        transition: background var(--gp-transition), border-color var(--gp-transition), color var(--gp-transition);
      }
      .gp-tool-button:first-child {
        margin-left: 0;
      }
      .gp-tool-button:hover {
        background: var(--gp-hover);
        border-color: var(--gp-border);
        color: var(--gp-fg);
      }
      .gp-tool-button svg {
        width: 20px;
        height: 20px;
        fill: none;
        flex: 0 0 20px;
        display: block;
      }
      .gp-tool-button span {
        display: inline-block;
        line-height: 1;
        -webkit-text-stroke: 0 transparent;
        -webkit-text-fill-color: currentColor;
        text-shadow: none;
        paint-order: normal;
      }
      .gp-primary {
        background: var(--gp-accent);
        color: var(--gp-on-accent);
        border: 1px solid var(--gp-accent);
        padding: 0 22px;
        font-size: 14px;
        font-weight: 600;
        transition: background var(--gp-transition), border-color var(--gp-transition), transform var(--gp-transition);
        overflow: hidden;
      }
      .gp-primary:hover {
        background: var(--gp-accent);
        border-color: var(--gp-accent);
        opacity: .88;
        transform: none;
      }
      :host(.dark) .gp-primary:hover {
        background: var(--gp-accent);
        border-color: var(--gp-accent);
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
        border-radius: var(--gp-radius-menu);
        box-shadow: var(--gp-shadow-menu);
        border: .5px solid var(--gp-border);
        padding: var(--gp-menu-inset);
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
        border-radius: var(--gp-radius-menu-item);
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
      .gp-menu-item.danger { color: var(--gp-danger); }
      .gp-project-menu {
        width: max-content;
        min-width: 0;
        max-width: calc(100vw - 16px);
        box-sizing: border-box;
        padding: var(--gp-menu-inset);
        border-radius: var(--gp-radius-menu);
      }
      .gp-menu .gp-menu-item {
        width: 100%;
        min-height: var(--gp-menu-item-height);
        justify-content: flex-start;
        gap: 10px;
        padding: 0 12px;
        border: 0;
        background: transparent;
        box-sizing: border-box;
        font-family: inherit;
        text-align: left;
        font-size: 14px;
        font-weight: 500;
      }
      .gp-menu .gp-menu-item svg {
        flex: 0 0 18px;
      }
      .gp-menu .gp-menu-item:hover,
      .gp-menu .gp-menu-item:focus-visible {
        background: var(--gp-hover);
      }
      .gp-menu .gp-menu-item:focus-visible {
        outline: 2px solid var(--gp-focus);
        outline-offset: -2px;
      }
      .gp-menu .gp-menu-item:disabled {
        cursor: wait;
        opacity: 0.6;
      }
      .gp-section-menu {
        width: 264px;
        max-width: calc(100vw - 16px);
        box-sizing: border-box;
        padding: 6px;
        border-radius: 20px;
      }
      .gp-section-menu-list {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .gp-section-menu .gp-menu-item {
        min-height: 36px;
        padding: 6px 12px;
        gap: 10px;
        border-radius: 14px;
      }
      .gp-section-menu .gp-menu-item svg {
        width: 18px;
        height: 18px;
        flex: 0 0 18px;
        display: block;
      }
      .gp-section-menu .gp-sync-row {
        min-height: 44px;
        padding: 7px 12px;
        align-items: center;
      }
      .gp-sync-copy {
        flex: 1 1 auto;
        display: flex;
        flex-direction: column;
        gap: 1px;
        min-width: 0;
      }
      .gp-sync-title {
        font-size: 14px;
        font-weight: 500;
        line-height: 18px;
        color: var(--gp-fg);
      }
      .gp-sync-meta {
        font-size: 12px;
        font-weight: 400;
        line-height: 15px;
        color: var(--gp-muted);
      }
      .gp-drive-status-dot {
        width: 7px;
        height: 7px;
        flex: 0 0 7px;
        margin-left: 10px;
        border-radius: var(--gp-radius-circle);
        background: #2f9e5b;
      }
      .gp-drive-status-dot.warn {
        background: #b5653f;
      }
      :host(.dark) .gp-drive-status-dot.warn,
      :host([data-gp-theme="dark"]) .gp-drive-status-dot.warn {
        background: #e0a28b;
      }
      .gp-menu-divider {
        height: 1px;
        background: var(--gp-border);
        margin: 4px 12px;
      }
      .gp-sync-row-wrap {
        display: flex;
        align-items: center;
        gap: 2px;
      }
      .gp-sync-row-wrap .gp-sync-row {
        flex: 1 1 auto;
        min-width: 0;
        width: auto;
      }
      .gp-sync-help-btn {
        width: 28px;
        height: 28px;
        flex: 0 0 28px;
        margin-right: 4px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 0;
        border-radius: var(--gp-radius-circle);
        background: transparent;
        color: var(--gp-muted);
        opacity: 0.72;
        cursor: pointer;
        padding: 0;
        transition: background-color 0.15s ease, color 0.15s ease, opacity 0.15s ease;
      }
      .gp-sync-help-btn svg {
        width: 16px;
        height: 16px;
        flex: 0 0 16px;
        display: block;
      }
      .gp-sync-help-btn:hover,
      .gp-sync-help-btn.active {
        background: var(--gp-hover);
        color: var(--gp-fg);
        opacity: 1;
      }
      .gp-sync-help-btn:focus-visible {
        outline: 2px solid var(--gp-focus);
        outline-offset: -2px;
        opacity: 1;
      }
      .gp-sync-help-collapse {
        display: grid;
        grid-template-rows: 0fr;
        opacity: 0;
        transition: grid-template-rows 0.18s ease, opacity 0.15s ease;
      }
      .gp-sync-help-collapse.open {
        grid-template-rows: 1fr;
        opacity: 1;
      }
      .gp-sync-help-inner {
        overflow: hidden;
      }
      .gp-sync-help-card {
        margin: 2px 4px 4px;
        padding: 8px 10px;
        border-radius: 12px;
        background: var(--gp-surface-footer);
        color: var(--gp-muted);
        font-size: 12px;
        line-height: 1.45;
        white-space: normal;
      }

      /* Chat menu item with icons */
      .gp-chat-menu {
        width: max-content;
        min-width: 0;
        max-width: calc(100vw - 16px);
        box-sizing: border-box;
        padding: var(--gp-menu-inset);
        border-radius: var(--gp-radius-menu);
      }
      .gp-chat-menu .gp-menu-item {
        justify-content: flex-start;
        gap: 10px;
        min-height: var(--gp-menu-item-height);
        padding: 0 12px;
        font-size: 14px;
        font-weight: 500;
      }
      .gp-chat-menu .gp-menu-item svg {
        width: 18px;
        height: 18px;
        flex-shrink: 0;
      }
      .gp-chat-menu .gp-menu-item span {
        flex: 1 1 auto;
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .gp-chat-menu .gp-submenu-arrow {
        flex: 0 0 16px;
        width: 16px;
        height: 16px;
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
        width: max-content;
        min-width: 0;
        max-width: calc(100vw - 16px);
        max-height: calc(100vh - 16px);
        overflow-y: auto;
        box-sizing: border-box;
        background: var(--gp-surface);
        border-radius: var(--gp-radius-menu);
        box-shadow: var(--gp-shadow-menu);
        border: .5px solid var(--gp-border);
        padding: var(--gp-menu-inset);
        display: none;
        z-index: 2147483647;
        font-family: var(--gp-font);
      }
      .gp-submenu .gp-menu-item {
        justify-content: flex-start;
        gap: 10px;
        min-height: var(--gp-menu-item-height);
        padding: 0 12px;
        font-size: 14px;
      }
      .gp-submenu .gp-menu-item svg {
        width: 18px;
        height: 18px;
      }
      @media (max-width: 560px) {
        .gp-modal { --gp-icon-columns: 8; }
      }
      @media (max-width: 440px) {
        .gp-modal { --gp-icon-columns: 6; }
        .gp-template-grid { gap: 4px; }
      }
      @media (max-width: 360px) { .gp-modal { --gp-icon-columns: 5; } }
      @media (prefers-reduced-motion: reduce) { .gp-modal *, .gp-menu *, .gp-submenu * { transition: none !important; } }
      .gp-toast {
        position: fixed;
        bottom: 24px;
        right: 24px;
        background: var(--gp-toast-bg);
        color: var(--gp-toast-fg);
        padding: 10px 16px;
        border-radius: var(--gp-radius-pill);
        font-size: 13px;
        font-weight: 500;
        display: none;
        pointer-events: auto;
        border: .5px solid var(--gp-border);
        box-shadow: var(--gp-shadow-menu);
        font-family: var(--gp-font);
      }
    `;
    shadow.appendChild(style);
  }
  return layer;
}

function createModal(layer: HTMLElement, signal: AbortSignal) {
  const backdrop = document.createElement('div');
  backdrop.className = 'gp-modal-backdrop';
  backdrop.innerHTML = `
    <div class="gp-modal" data-gp-motion-surface role="dialog" tabindex="-1" aria-modal="true" aria-labelledby="gp-project-dialog-title">
      <div class="gp-modal-header">
        <h2 id="gp-project-dialog-title" data-gp-modal-title>Create Project</h2>
        <button class="gp-modal-close" data-gp-action="close" aria-label="Close">
          ${renderUiIcon('x', 18)}
        </button>
      </div>
      <div class="gp-modal-body">
      ${ProjectNameInputWithIcon()}
      <p class="gp-form-status" role="alert" data-gp-form-status></p>
      <div class="gp-template-row" data-gp-template-row role="group" aria-label="Project icon">
        <div class="gp-icon-toolbar">
          <div class="gp-color-row" role="group" aria-label="Project color">
            <button class="gp-color-dot gp-color-multicolor" type="button" data-gp-color="${MULTICOLOR}"
              title="Multicolor" aria-label="Multicolor" aria-pressed="false"></button>
            ${COLOR_OPTIONS.map(({ color, label }) => `
              <button class="gp-color-dot${color === ADAPTIVE_PROJECT_COLOR ? ' gp-color-adaptive' : ''}"
                type="button" data-gp-color="${color}" title="${label}" aria-label="${label}" aria-pressed="false"
                ${color === ADAPTIVE_PROJECT_COLOR ? '' : `style="--gp-choice-color:${color}"`}></button>
            `).join('')}
          </div>
          <div class="gp-icon-style-switcher" role="radiogroup" aria-label="Project icon style">
            ${PROJECT_ICON_STYLES.map((style) => `
              <label class="gp-icon-style-option">
                <input type="radio" name="gp-project-icon-style" value="${style}" ${style === DEFAULT_PROJECT_ICON_STYLE ? 'checked' : ''}>
                <span>${style[0].toUpperCase() + style.slice(1)}</span>
              </label>
            `).join('')}
          </div>
        </div>
        <div class="gp-template-grid">
          ${ICON_OPTIONS.map((icon) => `
            <button class="gp-template-chip" type="button" data-gp-template="${icon.id}" data-gp-template-label="${icon.label}"
              title="${icon.label}" aria-label="${icon.label}" aria-pressed="false"
              style="--gp-icon-palette-color:${getPaletteIconColor(icon.id)}">
            </button>
          `).join('')}
        </div>
      </div>
      </div>
      <div class="gp-modal-actions">
        <button class="gp-tool-button" type="button" data-gp-action="cancel" data-gp-press>Cancel</button>
        <button class="gp-primary" data-gp-action="confirm" data-gp-press disabled>Done</button>
      </div>
    </div>
  `;
  layer.appendChild(backdrop);

  let saving = false;
  let returnFocus: (() => HTMLElement | null) | null = null;
  let confirmLabel = 'Done';
  const dialog = backdrop.querySelector<HTMLElement>('.gp-modal')!;
  const disabledBeforeSave = new Map<HTMLInputElement | HTMLButtonElement, boolean>();

  function open(
    config: { title: string; confirmLabel: string; name: string; showIcons: boolean },
    resolveFocus: () => HTMLElement | null
  ) {
    if (saving) return;
    returnFocus = resolveFocus;
    confirmLabel = config.confirmLabel;
    const title = backdrop.querySelector<HTMLElement>('[data-gp-modal-title]');
    const confirm = backdrop.querySelector<HTMLButtonElement>('[data-gp-action="confirm"]');
    const input = backdrop.querySelector<HTMLInputElement>('[data-gp-name-input]');
    const templateRow = backdrop.querySelector<HTMLElement>('[data-gp-template-row]');
    if (title) title.textContent = config.title;
    if (confirm) confirm.textContent = config.confirmLabel;
    if (input) input.value = config.name;
    if (templateRow) templateRow.style.display = config.showIcons ? 'flex' : 'none';
    setError('');
    showSurface(backdrop, 'modal', 'flex');
  }

  function close() {
    if (saving || backdrop.dataset.gpMotionState !== 'open') return;
    hideSurface(backdrop);
    const target = returnFocus?.();
    if (target?.isConnected) target.focus({ preventScroll: true });
  }

  function setError(message: string) {
    backdrop.querySelector<HTMLElement>('[data-gp-form-status]')!.textContent = message;
  }

  function setSaving(next: boolean) {
    if (saving === next) return;
    saving = next;
    const confirm = backdrop.querySelector<HTMLButtonElement>('[data-gp-action="confirm"]')!;
    dialog.setAttribute('aria-busy', String(saving));
    if (saving) {
      backdrop.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach((control) => {
        disabledBeforeSave.set(control, control.disabled);
        control.disabled = true;
      });
      confirm.textContent = 'Saving…';
      dialog.focus({ preventScroll: true });
    } else {
      disabledBeforeSave.forEach((disabled, control) => { control.disabled = disabled; });
      disabledBeforeSave.clear();
      confirm.textContent = confirmLabel;
    }
  }

  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });
  backdrop.querySelector('[data-gp-action="close"]')?.addEventListener('click', close);

  document.addEventListener('keydown', (event) => {
    if (backdrop.dataset.gpMotionState !== 'open') return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    } else if (event.key === 'Tab') {
      const controls = Array.from(backdrop.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)'))
        .filter((control) => control.getBoundingClientRect().height > 0);
      const active = event.composedPath()[0] as HTMLElement;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first) {
        event.preventDefault();
        dialog.focus();
      } else if (event.shiftKey && (active === first || !controls.includes(active))) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (active === last || !controls.includes(active))) {
        event.preventDefault(); first.focus();
      }
    } else if (event.key === 'Enter' && !event.isComposing && !saving
      && event.composedPath()[0] === backdrop.querySelector('[data-gp-name-input]')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      backdrop.querySelector<HTMLButtonElement>('[data-gp-action="confirm"]')?.click();
    }
  }, { capture: true, signal });

  return { element: backdrop, open, close, setError, setSaving, isSaving: () => saving };

}

function createProjectMenu(layer: HTMLElement, signal: AbortSignal) {
  const menu = document.createElement('div');
  menu.className = 'gp-menu gp-project-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Project actions');
  layer.appendChild(menu);

  type ProjectMenuCallbacks = {
    onTogglePin: () => Promise<void>;
    onPinError: (error: unknown) => void;
    onEdit: () => void;
    onDelete: () => void;
    onReturnFocus: () => void;
  };
  let callbacks: ProjectMenuCallbacks | null = null;
  let opener: HTMLElement | null = null;
  let pinPending = false;
  let deleteConfirming = false;
  let deleteConfirmTimer: number | null = null;

  function resetDeleteConfirm() {
    deleteConfirming = false;
    if (deleteConfirmTimer !== null) {
      window.clearTimeout(deleteConfirmTimer);
      deleteConfirmTimer = null;
    }
    const deleteSpan = menu.querySelector<HTMLElement>('[data-gp-menu="delete"] span');
    if (deleteSpan) deleteSpan.textContent = 'Delete';
  }

  function open(anchor: HTMLButtonElement, project: Project, nextCallbacks: ProjectMenuCallbacks) {
    if (pinPending) return;
    resetDeleteConfirm();
    callbacks = nextCallbacks;
    opener = anchor;
    const anchorRect = anchor.getBoundingClientRect();
    menu.innerHTML = `
      <button type="button" role="menuitem" class="gp-menu-item" data-gp-menu="pin">${renderProjectActionIcon(project.isPinned ? 'unpin' : 'pin')}<span>${project.isPinned ? 'Unpin' : 'Pin'}</span></button>
      <button type="button" role="menuitem" class="gp-menu-item" data-gp-menu="edit">${renderProjectActionIcon('edit')}<span>Edit</span></button>
      <button type="button" role="menuitem" class="gp-menu-item danger" data-gp-menu="delete">${renderProjectActionIcon('delete')}<span>Delete</span></button>
    `;
    showSurface(menu, 'menu', 'block', () => {
      const width = menu.offsetWidth;
      const height = menu.offsetHeight;
      const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - width - 8));
      const preferredTop = anchorRect.bottom + 6;
      const top = Math.max(8, Math.min(
        preferredTop + height <= window.innerHeight - 8 ? preferredTop : anchorRect.top - height - 6,
        window.innerHeight - height - 8
      ));
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
      setSurfaceOrigin(menu, anchorRect, left, top);
    });
    menu.querySelector<HTMLButtonElement>('[data-gp-menu]')?.focus();
  }

  function close(restoreFocus = false) {
    resetDeleteConfirm();
    hideSurface(menu);
    if (restoreFocus) callbacks?.onReturnFocus();
    callbacks = null;
    opener = null;
  }

  menu.addEventListener('click', async (event) => {
    const target = (event.target as HTMLElement).closest('[data-gp-menu]') as HTMLElement | null;
    if (!target || !callbacks || pinPending) {
      return;
    }
    const action = target.dataset.gpMenu;
    if (action === 'pin') {
      const activeCallbacks = callbacks;
      const label = target.querySelector('span')!;
      const originalLabel = label.textContent;
      pinPending = true;
      menu.setAttribute('aria-busy', 'true');
      menu.querySelectorAll<HTMLButtonElement>('button').forEach((button) => { button.disabled = true; });
      label.textContent = originalLabel === 'Unpin' ? 'Unpinning…' : 'Pinning…';
      try {
        await activeCallbacks.onTogglePin();
        close(true);
      } catch (error) {
        activeCallbacks.onPinError(error);
      } finally {
        pinPending = false;
        menu.removeAttribute('aria-busy');
        label.textContent = originalLabel;
        menu.querySelectorAll<HTMLButtonElement>('button').forEach((button) => { button.disabled = false; });
      }
      return;
    }
    if (action === 'delete') {
      if (!deleteConfirming) {
        deleteConfirming = true;
        const label = target.querySelector('span');
        if (label) label.textContent = 'Confirm Delete';
        if (deleteConfirmTimer !== null) window.clearTimeout(deleteConfirmTimer);
        deleteConfirmTimer = window.setTimeout(() => resetDeleteConfirm(), 2200);
        return;
      }
      resetDeleteConfirm();
      callbacks.onDelete();
      close(true);
      return;
    }
    if (action === 'edit') callbacks.onEdit();
    close();
  });

  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'Tab') {
      close(true);
    } else if (!pinPending) {
      moveMenuFocus(menu, event);
    }
  });

  document.addEventListener('click', (event) => {
    const path = event.composedPath();
    if (!path.includes(menu) && !path.includes(opener!)) close();
  }, { signal, capture: true });
  window.addEventListener('resize', () => close(), { signal });

  return { open, close };
}

function createSectionMenu(layer: HTMLElement, signal: AbortSignal) {
  const menu = document.createElement('div');
  menu.className = 'gp-menu gp-section-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Projects options');
  layer.appendChild(menu);

  type SectionMenuCallbacks = {
    onReturnFocus: () => void;
    onSyncNow: () => Promise<void>;
    onConnectGoogleDrive: () => Promise<void>;
    onDisconnectGoogleDrive: () => Promise<void>;
    onSyncError: (error: unknown) => void;
    onBackup: () => void;
    onRestore: () => void;
  };

  let callbacks: SectionMenuCallbacks | null = null;
  let opener: HTMLElement | null = null;
  let status: CloudSyncStatus = createDefaultSyncStatus();
  let busy = false;
  let connectingDrive = false;
  let helpExpanded = false;
  let helpRepositionTimer: number | null = null;

  function clearHelpRepositionTimer() {
    if (helpRepositionTimer !== null) {
      window.clearTimeout(helpRepositionTimer);
      helpRepositionTimer = null;
    }
  }

  function getSyncHelpText(): string {
    return status.enabled
      ? 'Syncing via a hidden app-only Drive folder. Connect on other devices too — syncs automatically every ~15s, or anytime with Sync now.'
      : 'Sync across browsers (Chrome, Aside, Edge, Brave) via a hidden app-only Drive folder. Never accesses your Drive files. Off by default.';
  }

  function isOpen(): boolean {
    return menu.dataset.gpMotionState === 'open';
  }

  function renderItems(preserveFocusAction?: string | null) {
    const warningTitle = getSyncWarningTitle(status);
    const helpToggleMarkup = `
      <button type="button" class="gp-sync-help-btn${helpExpanded ? ' active' : ''}" data-gp-section-action="toggle-sync-help" aria-label="About Google Drive sync" aria-expanded="${helpExpanded ? 'true' : 'false'}">
        ${renderUiIcon('helpCircle', 16)}
      </button>
    `;
    const helpCollapseMarkup = `
      <div class="gp-sync-help-collapse${helpExpanded ? ' open' : ''}" aria-hidden="${helpExpanded ? 'false' : 'true'}">
        <div class="gp-sync-help-inner">
          <div class="gp-sync-help-card">${escapeHtml(getSyncHelpText())}</div>
        </div>
      </div>
    `;

    let syncSectionMarkup = '';
    if (status.enabled) {
      const isExpired = status.state === 'auth_expired';
      const hasDriveWarning = isExpired || status.state === 'error';
      const driveMeta = connectingDrive
        ? 'Reconnecting…'
        : formatDriveStatusLabel(status);
      const primaryActionDisabled = busy || status.state === 'syncing' || !status.available;
      syncSectionMarkup = `
        <div class="gp-sync-row-wrap">
          <button type="button" role="menuitem" class="gp-menu-item gp-sync-row" data-gp-section-action="drive-header"${primaryActionDisabled ? ' disabled' : ''}${warningTitle ? ` title="${escapeAttr(warningTitle)}"` : ''}>
            ${renderUiIcon('googleDrive', 18)}
            <span class="gp-sync-copy">
              <span class="gp-sync-title">Google Drive</span>
              <span class="gp-sync-meta">${escapeHtml(driveMeta)}</span>
            </span>
            <span class="gp-drive-status-dot${hasDriveWarning ? ' warn' : ''}" aria-hidden="true"></span>
          </button>
          ${helpToggleMarkup}
        </div>
        ${helpCollapseMarkup}
        ${isExpired ? `
          <button type="button" role="menuitem" class="gp-menu-item" data-gp-section-action="reconnect-drive"${primaryActionDisabled ? ' disabled' : ''}>
            ${renderUiIcon('refreshCw', 18)}
            <span>${connectingDrive ? 'Reconnecting…' : 'Reconnect'}</span>
          </button>
        ` : `
          <button type="button" role="menuitem" class="gp-menu-item" data-gp-section-action="sync-now"${primaryActionDisabled ? ' disabled' : ''}>
            ${renderUiIcon('refreshCw', 18)}
            <span>${status.state === 'syncing' ? 'Syncing…' : 'Sync now'}</span>
          </button>
        `}
        <button type="button" role="menuitem" class="gp-menu-item" data-gp-section-action="disconnect-drive"${busy ? ' disabled' : ''}>
          ${renderUiIcon('logOut', 18)}
          <span>Disconnect</span>
        </button>
      `;
    } else {
      const connectMeta = !status.available
        ? 'Unavailable'
        : connectingDrive
          ? 'Connecting…'
          : 'Connect';
      const connectDisabled = busy || !status.available;
      syncSectionMarkup = `
        <div class="gp-sync-row-wrap">
          <button type="button" role="menuitem" class="gp-menu-item gp-sync-row" data-gp-section-action="connect-drive"${connectDisabled ? ' disabled' : ''}>
            ${renderUiIcon('googleDrive', 18)}
            <span class="gp-sync-copy">
              <span class="gp-sync-title">Google Drive</span>
              <span class="gp-sync-meta">${escapeHtml(connectMeta)}</span>
            </span>
          </button>
          ${helpToggleMarkup}
        </div>
        ${helpCollapseMarkup}
      `;
    }

    menu.innerHTML = `
      <div class="gp-section-menu-list">
        ${syncSectionMarkup}
        <div class="gp-menu-divider" role="separator"></div>
        <button type="button" role="menuitem" class="gp-menu-item" data-gp-section-action="backup">
          ${renderUiIcon('download', 18)}
          <span>Backup</span>
        </button>
        <button type="button" role="menuitem" class="gp-menu-item" data-gp-section-action="restore">
          ${renderUiIcon('rotateCcw', 18)}
          <span>Restore</span>
        </button>
      </div>
    `;

    if (preserveFocusAction) {
      const target = menu.querySelector<HTMLButtonElement>(`[data-gp-section-action="${preserveFocusAction}"]:not(:disabled)`);
      target?.focus({ preventScroll: true });
    }
  }

  function positionMenu(anchorRect: DOMRect) {
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const preferredLeft = anchorRect.right - width;
    const left = Math.max(8, Math.min(preferredLeft, window.innerWidth - width - 8));
    const preferredTop = anchorRect.bottom + 6;
    const top = Math.max(8, Math.min(
      preferredTop + height <= window.innerHeight - 8 ? preferredTop : anchorRect.top - height - 6,
      window.innerHeight - height - 8
    ));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    setSurfaceOrigin(menu, anchorRect, left, top);
  }

  function open(anchor: HTMLButtonElement, nextStatus: CloudSyncStatus, nextCallbacks: SectionMenuCallbacks) {
    clearHelpRepositionTimer();
    helpExpanded = false;
    callbacks = nextCallbacks;
    opener = anchor;
    status = nextStatus;
    anchor.setAttribute('aria-expanded', 'true');
    const anchorRect = anchor.getBoundingClientRect();
    renderItems();
    showSurface(menu, 'menu', 'block', () => positionMenu(anchorRect));
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }

  function update(nextStatus: CloudSyncStatus) {
    status = nextStatus;
    if (!isOpen()) return;
    const active = (layer.getRootNode() as ShadowRoot).activeElement as HTMLElement | null;
    const focusAction = active?.dataset?.gpSectionAction ?? null;
    renderItems(focusAction);
    if (opener?.isConnected) {
      positionMenu(opener.getBoundingClientRect());
    }
  }

  function close(restoreFocus = false) {
    clearHelpRepositionTimer();
    helpExpanded = false;
    const currentOpener = opener;
    const currentCallbacks = callbacks;
    currentOpener?.setAttribute('aria-expanded', 'false');
    hideSurface(menu);
    callbacks = null;
    opener = null;
    if (restoreFocus) currentCallbacks?.onReturnFocus();
  }

  menu.addEventListener('click', async (event) => {
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-gp-section-action]');
    if (!target || !callbacks || target.disabled) return;
    const action = target.dataset.gpSectionAction;

    if (action === 'toggle-sync-help') {
      helpExpanded = !helpExpanded;
      target.classList.toggle('active', helpExpanded);
      target.setAttribute('aria-expanded', helpExpanded ? 'true' : 'false');
      const collapse = menu.querySelector<HTMLElement>('.gp-sync-help-collapse');
      if (collapse) {
        collapse.classList.toggle('open', helpExpanded);
        collapse.setAttribute('aria-hidden', helpExpanded ? 'false' : 'true');
      }
      // 展开或收起动画结束后按视口重新定位，避免短屏裁切或停留在锚点上方
      clearHelpRepositionTimer();
      if (opener?.isConnected) {
        helpRepositionTimer = window.setTimeout(() => {
          helpRepositionTimer = null;
          if (!isOpen() || !opener?.isConnected) return;
          if (!helpExpanded || menu.getBoundingClientRect().bottom > window.innerHeight - 8) {
            positionMenu(opener.getBoundingClientRect());
          }
        }, 190);
      }
      return;
    }

    if (action === 'sync-now' || (action === 'drive-header' && status.state !== 'auth_expired')) {
      if (busy || !status.available || !status.enabled) return;
      const activeCallbacks = callbacks;
      busy = true;
      renderItems(action);
      try {
        await activeCallbacks.onSyncNow();
        close(true);
      } catch (error) {
        activeCallbacks.onSyncError(error);
      } finally {
        busy = false;
        if (isOpen()) renderItems(action);
      }
      return;
    }

    if (
      action === 'connect-drive' ||
      action === 'reconnect-drive' ||
      (action === 'drive-header' && status.state === 'auth_expired')
    ) {
      if (busy || !status.available) return;
      const activeCallbacks = callbacks;
      busy = true;
      connectingDrive = true;
      renderItems(action);
      try {
        await activeCallbacks.onConnectGoogleDrive();
        if (isOpen()) close(true);
      } catch (error) {
        activeCallbacks.onSyncError(error);
      } finally {
        busy = false;
        connectingDrive = false;
        if (isOpen()) renderItems(action);
      }
      return;
    }

    if (action === 'disconnect-drive') {
      if (busy) return;
      const activeCallbacks = callbacks;
      busy = true;
      renderItems('disconnect-drive');
      try {
        await activeCallbacks.onDisconnectGoogleDrive();
        if (isOpen()) close(true);
      } catch (error) {
        activeCallbacks.onSyncError(error);
      } finally {
        busy = false;
        if (isOpen()) renderItems();
      }
      return;
    }

    if (action === 'backup') {
      const cb = callbacks.onBackup;
      close(true);
      cb();
      return;
    }

    if (action === 'restore') {
      const cb = callbacks.onRestore;
      close(true);
      cb();
    }
  });

  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'Tab') {
      close(true);
    } else if (!busy) {
      moveMenuFocus(menu, event);
    }
  });

  document.addEventListener('click', (event) => {
    if (!isOpen()) return;
    const path = event.composedPath();
    if (!path.includes(menu) && !path.includes(opener!)) close();
  }, { signal, capture: true });
  window.addEventListener('resize', () => { if (isOpen()) close(); }, { signal });

  return { open, update, close, isOpen };
}

// 聊天项右键菜单 (Chat row context menu)
function createChatMenu(layer: HTMLElement, getProjects: () => Project[], signal: AbortSignal) {
  const menu = document.createElement('div');
  menu.className = 'gp-menu gp-chat-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('data-gp-motion-fixed-children', '');
  layer.appendChild(menu);

  let callbacks: {
    onRemove: () => void;
    onMoveToProject: (projectId: string) => void;
  } | null = null;
  let opener: HTMLElement | null = null;
  let closeSubmenu: ((restoreFocus?: boolean) => void) | null = null;
  let submenuCloseTimer: number | undefined;
  let hoverController: AbortController | null = null;
  function cancelSubmenuClose() {
    window.clearTimeout(submenuCloseTimer);
    submenuCloseTimer = undefined;
  }
  function scheduleSubmenuClose(submenu: HTMLElement) {
    cancelSubmenuClose();
    submenuCloseTimer = window.setTimeout(() => {
      submenuCloseTimer = undefined;
      if (!submenu.contains((layer.getRootNode() as ShadowRoot).activeElement)) closeSubmenu?.();
    }, 150);
  }

  function open(
    anchor: HTMLElement,
    projectId: string,
    projectName: string,
    nextCallbacks: {
      onRemove: () => void;
      onMoveToProject: (projectId: string) => void;
    }
  ) {
    close();
    hoverController = new AbortController();
    callbacks = nextCallbacks;
    opener = anchor;
    const anchorRect = anchor.getBoundingClientRect();

    // 获取其他项目列表（排除当前项目）
    const otherProjects = getProjects().filter(p => p.id !== projectId);

    menu.innerHTML = `
      <button type="button" role="menuitem" class="gp-menu-item" data-gp-chat-action="remove">
        ${renderUiIcon('logOut', 18)}
        <span>Remove from ${escapeHtml(projectName)}</span>
      </button>
      ${otherProjects.length > 0 ? `
        <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded="false" class="gp-menu-item gp-submenu-trigger" data-gp-chat-action="move-trigger">
          ${renderUiIcon('folderPlus', 18)}
          <span>Move to Project</span>
          ${renderUiIcon('chevronRight', 16, 'gp-submenu-arrow')}
        </button>
        <div class="gp-submenu" role="menu" aria-label="Move to Project">
          ${otherProjects.map(p => `
            <button type="button" role="menuitem" class="gp-menu-item" data-gp-chat-action="move" data-gp-target-project="${escapeAttr(p.id)}">
              ${renderIconSvg(p.icon, p.iconStyle, p.color)}
              <span>${escapeHtml(p.name)}</span>
            </button>
          `).join('')}
        </div>
      ` : ''}
    `;

    // 显示后按实际内容尺寸定位，不再依赖固定宽度。
    showSurface(menu, 'menu', 'block', () => {
      const menuRect = { width: menu.offsetWidth, height: menu.offsetHeight };
      const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - menuRect.width - 8));
      const preferredTop = anchorRect.bottom + 6;
      const top = Math.max(8, Math.min(
        preferredTop + menuRect.height <= window.innerHeight - 8 ? preferredTop : anchorRect.top - menuRect.height - 6,
        window.innerHeight - menuRect.height - 8
      ));
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
      setSurfaceOrigin(menu, anchorRect, left, top);
    });
    menu.querySelector('button')?.focus({ preventScroll: true });

    const trigger = menu.querySelector<HTMLButtonElement>('.gp-submenu-trigger');
    const submenu = menu.querySelector<HTMLElement>('.gp-submenu');
    if (trigger && submenu) {
      const listeners = { signal: hoverController.signal };
      const openSubmenu = (focus: boolean) => {
        cancelSubmenuClose();
        trigger.setAttribute('aria-expanded', 'true');
        showSurface(submenu, 'menu', 'block', () => {
          const triggerRect = trigger.getBoundingClientRect();
          const submenuRect = { width: submenu.offsetWidth, height: submenu.offsetHeight };
          const preferredLeft = triggerRect.right - 4;
          const submenuLeft = Math.max(8, Math.min(
            preferredLeft + submenuRect.width <= window.innerWidth - 8
              ? preferredLeft : triggerRect.left - submenuRect.width + 4,
            window.innerWidth - submenuRect.width - 8
          ));
          const submenuTop = Math.max(8, Math.min(triggerRect.top, window.innerHeight - submenuRect.height - 8));
          submenu.style.left = `${submenuLeft}px`;
          submenu.style.top = `${submenuTop}px`;
          setSurfaceOrigin(submenu, triggerRect, submenuLeft, submenuTop);
        });
        if (focus) submenu.querySelector('button')?.focus({ preventScroll: true });
      };
      closeSubmenu = (restoreFocus = false) => {
        cancelSubmenuClose();
        trigger.setAttribute('aria-expanded', 'false');
        hideSurface(submenu);
        if (restoreFocus) trigger.focus({ preventScroll: true });
      };
      trigger.addEventListener('mouseenter', () => openSubmenu(false), listeners);
      trigger.addEventListener('click', () => openSubmenu(true), listeners);
      trigger.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowRight') return;
        event.preventDefault();
        openSubmenu(true);
      }, listeners);
      trigger.addEventListener('mouseleave', (e) => {
        const related = (e as MouseEvent).relatedTarget as HTMLElement | null;
        if (related && submenu.contains(related)) return;
        scheduleSubmenuClose(submenu);
      }, listeners);
      submenu.addEventListener('mouseenter', cancelSubmenuClose, listeners);
      submenu.addEventListener('mouseleave', (event) => {
        if (event.relatedTarget instanceof Node && trigger.contains(event.relatedTarget)) return;
        scheduleSubmenuClose(submenu);
      }, listeners);
    }
  }

  function close(restoreFocus = false) {
    closeSubmenu?.();
    closeSubmenu = null;
    hoverController?.abort();
    hoverController = null;
    cancelSubmenuClose();
    hideSurface(menu);
    callbacks = null;
    if (restoreFocus && opener?.isConnected) opener.focus({ preventScroll: true });
    opener = null;
  }

  menu.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest('[data-gp-chat-action]') as HTMLElement | null;
    if (!target || !callbacks) return;

    const action = target.dataset.gpChatAction;
    if (action === 'remove') {
      callbacks.onRemove();
      close(true);
    } else if (action === 'move') {
      const targetProjectId = target.dataset.gpTargetProject;
      if (targetProjectId) {
        callbacks.onMoveToProject(targetProjectId);
        close(true);
      }
    }
  });

  menu.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement;
    const submenu = target.closest<HTMLElement>('.gp-submenu');
    if (event.key === 'Escape' || (submenu && event.key === 'ArrowLeft')) {
      event.preventDefault();
      event.stopPropagation();
      if (submenu) closeSubmenu?.(true);
      else close(true);
    } else if (event.key === 'Tab') {
      close(true);
    } else {
      moveMenuFocus(submenu ?? menu, event);
    }
  });

  document.addEventListener('click', (event) => {
    if (!event.composedPath().includes(menu)) close();
  }, { signal, capture: true });
  window.addEventListener('resize', () => close(), { signal });

  return { open, close };
}

function createToast(layer: HTMLElement) {
  const toast = document.createElement('div');
  toast.className = 'gp-toast';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  toast.setAttribute('aria-atomic', 'true');
  layer.appendChild(toast);
  let timeoutId: number | null = null;

  function show(message: string) {
    toast.textContent = message;
    showSurface(toast, 'toast');
    if (timeoutId) {
      window.clearTimeout(timeoutId);
    }
    timeoutId = window.setTimeout(() => {
      hideSurface(toast);
      timeoutId = null;
    }, 2200);
  }

  function hide() {
    if (timeoutId) window.clearTimeout(timeoutId);
    timeoutId = null;
    hideSurface(toast);
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

function attachThemeObserver(panelRoot: HTMLElement, overlayLayer: HTMLElement): () => void {
  const getHost = (el: HTMLElement) => (el.getRootNode() as ShadowRoot).host as HTMLElement;
  const panelHost = getHost(panelRoot);
  const overlayHost = getHost(overlayLayer);

  return observeGeminiTheme((theme) => {
    const isDark = theme === 'dark';
    if (panelHost) {
      panelHost.classList.toggle('dark', isDark);
      panelHost.dataset.gpTheme = theme;
    }
    if (overlayHost) {
      overlayHost.classList.toggle('dark', isDark);
      overlayHost.dataset.gpTheme = theme;
    }
  });
}
