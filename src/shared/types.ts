import type { Prompt, PromptsData } from './prompts';

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
  isPinned?: boolean;
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

export type NativeChatMetadata = Pick<ChatRef, 'conversationId' | 'title' | 'lastUrl'>;

export type ProjectIconStyle = 'outline' | 'solid';

export interface UiPrefs {
  projectsCollapsed: boolean;
  projectIconStyle: ProjectIconStyle;
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
  nativeConversationIds: Set<string>;
  nativeChatsReady: boolean;
  activeConversationId: string | null;
  ui: UiState;
  uiPrefs: UiPrefs;
}

export type BackgroundRequest =
  | { type: 'getState' }
  | { type: 'upsertProject'; project: Project; editing: boolean }
  | { type: 'setProjectPinned'; projectId: string; isPinned: boolean }
  | { type: 'deleteProject'; projectId: string }
  | { type: 'moveChat'; conversationId: string; projectId: string | null; metadata?: NativeChatMetadata }
  | { type: 'upsertChatRefs'; chats: NativeChatMetadata[] }
  | { type: 'updateUiPrefs'; prefs: Partial<UiPrefs> }
  | { type: 'getPrompts' }
  | { type: 'savePrompt'; prompt: Pick<Prompt, 'title' | 'content'> & { id?: string } }
  | { type: 'deletePrompt' | 'trackPromptUsage'; id: string }
  | { type: 'restoreBackup'; data: unknown };

export type BackgroundResponse =
  | { ok: true; state?: StoredState; prompts?: PromptsData }
  | { ok: false; error: string };
