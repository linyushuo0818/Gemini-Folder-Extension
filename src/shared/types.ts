export type ProjectIcon =
  | 'investing'
  | 'homework'
  | 'writing'
  | 'travel'
  | 'health'
  | 'coding'
  | 'research'
  | 'default'
  | 'phone'
  | 'pen'
  | 'terminal'
  | 'music'
  | 'popcorn'
  | 'palette'
  | 'flower'
  | 'lotus'
  | 'briefcase'
  | 'chart'
  | 'apple'
  | 'dumbbell'
  | 'notebook'
  | 'scale'
  | 'globe'
  | 'airplane'
  | 'world'
  | 'paw'
  | 'people'
  | 'beaker'
  | 'clover'
  | 'heart';

export interface Project {
  id: string;
  name: string;
  icon: ProjectIcon;
  color?: string;
  createdAt: number;
  updatedAt: number;
  sortIndex: number;
}

export interface ChatRef {
  conversationId: string;
  title: string;
  isPinned?: boolean;
  projectId?: string | null;
  updatedAt: number;
  lastUrl?: string;
}

export interface UiPrefs {
  projectsCollapsed: boolean;
}

export interface StoredState {
  schemaVersion: number;
  projects: Project[];
  chatIndex: Record<string, ChatRef>;
  uiPrefs: UiPrefs;
}

export interface UiState {
  createModalOpen: boolean;
  contextMenuOpen: boolean;
  pendingMoveConversationId: string | null;
}

export interface RuntimeState {
  projects: Project[];
  chatIndex: Map<string, ChatRef>;
  expandedProjectIds: Set<string>;
  ui: UiState;
  uiPrefs: UiPrefs;
}

export type BackgroundRequest =
  | { type: 'getState' }
  | { type: 'upsertProject'; project: Project }
  | { type: 'renameProject'; projectId: string; name: string }
  | { type: 'deleteProject'; projectId: string }
  | { type: 'moveChat'; conversationId: string; projectId: string | null }
  | { type: 'upsertChatRefs'; chats: ChatRef[] }
  | { type: 'exportProject'; projectId: string }
  | { type: 'updateUiPrefs'; prefs: Partial<UiPrefs> }
  | { type: 'refreshStateCache' };

export type BackgroundResponse =
  | { ok: true; state?: StoredState; json?: string; filename?: string }
  | { ok: false; error: string };
