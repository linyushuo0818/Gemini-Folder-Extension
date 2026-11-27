import type { Prompt, PromptsData } from './prompts';
import type { CloudSyncStatus } from './sync';

export const PROJECT_ICONS = [
  'investing',
  'homework',
  'writing',
  'travel',
  'health',
  'coding',
  'research',
  'default',
  'phone',
  'pen',
  'terminal',
  'music',
  'popcorn',
  'palette',
  'flower',
  'lotus',
  'briefcase',
  'chart',
  'apple',
  'dumbbell',
  'notebook',
  'scale',
  'globe',
  'airplane',
  'world',
  'paw',
  'people',
  'beaker',
  'clover',
  'heart'
] as const;

export type ProjectIcon = typeof PROJECT_ICONS[number];

export interface Project {
  id: string;
  name: string;
  icon: ProjectIcon;
  iconStyle: ProjectIconStyle;
  color?: string;
  useIconPalette?: true;
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

export const PROJECT_ICON_STYLES = ['outline', 'solid', 'duotone'] as const;
export type ProjectIconStyle = typeof PROJECT_ICON_STYLES[number];
export const DEFAULT_PROJECT_ICON_STYLE: ProjectIconStyle = 'duotone';

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
  | { type: 'restoreBackup'; data: unknown }
  | { type: 'getSyncStatus' }
  | { type: 'syncNow' }
  | { type: 'connectGoogleDrive' }
  | { type: 'disconnectGoogleDrive' }
  | { type: 'syncIfStale' };

export type BackgroundResponse =
  | { ok: true; state?: StoredState; prompts?: PromptsData; syncStatus?: CloudSyncStatus }
  | { ok: false; error: string; syncStatus?: CloudSyncStatus };
