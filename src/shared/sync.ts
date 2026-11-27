import {
  ChatRef,
  DEFAULT_PROJECT_ICON_STYLE,
  Project,
  ProjectIcon,
  ProjectIconStyle,
  StoredState
} from './types';
import {
  CURRENT_SCHEMA_VERSION,
  isProjectColor,
  isProjectIconStyle,
  isRecord,
  isSafeId,
  normalizeChatUrl,
  sanitizeProject
} from './storage';
import { Prompt, PromptsData, sanitizePrompt } from './prompts';

export const SYNC_LOCAL_META_KEY = 'gp_sync_local_meta_v1';
export const DRIVE_AUTH_STORAGE_KEY = 'gp_drive_auth_v1';
export const DRIVE_SYNC_FILENAME = 'gemini-projects-sync-v1.json';
export const SYNC_STALE_INTERVAL_MS = 15_000;
export const SYNC_SCHEMA_VERSION = 1;

export const DRIVE_TOMBSTONES_BYTE_LIMIT = 256 * 1024;
export const SYNC_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SYNC_CHAT_TITLE_MAX_LEN = 200;

export interface SyncProject {
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

export interface SyncChat {
  id: string;
  projectId: string;
  title: string;
  lastUrl?: string;
  isPinned?: boolean;
  updatedAt: number;
}

export interface SyncPrompt {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface SyncTombstones {
  projects: Record<string, number>;
  chats: Record<string, number>;
  prompts: Record<string, number>;
}

export type CloudSyncState =
  | 'disabled'
  | 'syncing'
  | 'synced'
  | 'auth_expired'
  | 'unavailable'
  | 'error';

export interface CloudSyncStatus {
  enabled: boolean;
  available: boolean;
  state: CloudSyncState;
  lastSyncedAt: number | null;
  lastError?: string;
  bytesUsed?: number;
}

export interface SyncLocalMeta {
  enabled: boolean;
  clientId: string;
  driveFileId?: string;
  driveLastModifiedTime?: string;
  driveLastVersion?: string;
  lastSyncedRev: number;
  lastSyncedHash: string;
  lastSyncedAt: number | null;
  tombstones: SyncTombstones;
  status: CloudSyncStatus;
}

export interface SyncSnapshot {
  projects: SyncProject[];
  chats: SyncChat[];
  prompts: SyncPrompt[];
  tombstones: SyncTombstones;
}

export interface DriveSyncEnvelopeV1 {
  v: 1;
  clientId: string;
  rev: number;
  updatedAt: number;
  hash: string;
  snapshot: SyncSnapshot;
}

export type ParsedDriveEnvelope =
  | { kind: 'invalid'; reason: string }
  | { kind: 'valid'; envelope: DriveSyncEnvelopeV1 };

export interface MergeResult {
  state: StoredState;
  prompts: PromptsData;
  tombstones: SyncTombstones;
  stateChanged: boolean;
  promptsChanged: boolean;
}

const utf8Encoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

export function createEmptyTombstones(): SyncTombstones {
  return { projects: {}, chats: {}, prompts: {} };
}

export function createDefaultSyncStatus(
  available = true,
  enabled = false
): CloudSyncStatus {
  const state: CloudSyncState = !available ? 'unavailable' : enabled ? 'synced' : 'disabled';
  return {
    enabled,
    available,
    state,
    lastSyncedAt: null
  };
}

export function createDefaultLocalMeta(
  clientId: string,
  available = true,
  enabled = false
): SyncLocalMeta {
  return {
    enabled,
    clientId,
    lastSyncedRev: 0,
    lastSyncedHash: '',
    lastSyncedAt: null,
    tombstones: createEmptyTombstones(),
    status: createDefaultSyncStatus(available, enabled)
  };
}

function capString(value: string, maxCodePoints: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxCodePoints) return trimmed;
  return Array.from(trimmed).slice(0, maxCodePoints).join('');
}

export function projectToSync(project: Project): SyncProject {
  const out: SyncProject = {
    id: project.id,
    name: project.name.trim(),
    icon: project.icon,
    iconStyle: project.iconStyle,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    sortIndex: project.sortIndex
  };
  if (isProjectColor(project.color)) out.color = project.color;
  if (project.useIconPalette === true) out.useIconPalette = true;
  if (project.isPinned === true) out.isPinned = true;
  return out;
}

export function chatToSync(chat: ChatRef): SyncChat | null {
  if (!chat.projectId || !isSafeId(chat.conversationId) || !isSafeId(chat.projectId)) return null;
  const out: SyncChat = {
    id: chat.conversationId,
    projectId: chat.projectId,
    title: capString(chat.title || '', SYNC_CHAT_TITLE_MAX_LEN),
    updatedAt: chat.updatedAt
  };
  const lastUrl = normalizeChatUrl(chat.lastUrl, chat.conversationId);
  if (lastUrl) out.lastUrl = lastUrl;
  if (chat.isPinned === true) out.isPinned = true;
  return out;
}

export function promptToSync(prompt: Prompt): SyncPrompt {
  return {
    id: prompt.id,
    title: prompt.title,
    content: prompt.content,
    createdAt: prompt.createdAt,
    updatedAt: prompt.updatedAt
  };
}

export function sortSyncProjects(projects: SyncProject[]): SyncProject[] {
  return [...projects].sort((a, b) =>
    a.sortIndex - b.sortIndex || a.createdAt - b.createdAt || compareAscii(a.id, b.id)
  );
}

export function sortSyncChats(chats: SyncChat[]): SyncChat[] {
  return [...chats].sort((a, b) => b.updatedAt - a.updatedAt || compareAscii(a.id, b.id));
}

export function sortSyncPrompts(prompts: SyncPrompt[]): SyncPrompt[] {
  return [...prompts].sort((a, b) => b.updatedAt - a.updatedAt || compareAscii(a.id, b.id));
}

function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortTombstoneBucket(bucket: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(bucket).sort(compareAscii)) {
    if (isSafeId(key) && Number.isFinite(bucket[key]) && bucket[key] > 0) {
      out[key] = bucket[key];
    }
  }
  return out;
}

export function pruneAndBoundTombstones(
  tombstones: SyncTombstones,
  now: number,
  byteLimit = DRIVE_TOMBSTONES_BYTE_LIMIT
): SyncTombstones {
  const cutoff = now - SYNC_TOMBSTONE_TTL_MS;
  const entries: Array<{ bucket: keyof SyncTombstones; id: string; deletedAt: number }> = [];

  for (const bucket of ['projects', 'chats', 'prompts'] as const) {
    const source = tombstones[bucket];
    if (!isRecord(source)) continue;
    for (const [id, ts] of Object.entries(source)) {
      if (!isSafeId(id) || typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) continue;
      if (ts < cutoff) continue;
      entries.push({ bucket, id, deletedAt: ts });
    }
  }

  // 快速路径：全部放得下时按字典序输出稳定结构。
  const full = createEmptyTombstones();
  for (const entry of entries) full[entry.bucket][entry.id] = entry.deletedAt;
  const normalizedFull: SyncTombstones = {
    projects: sortTombstoneBucket(full.projects),
    chats: sortTombstoneBucket(full.chats),
    prompts: sortTombstoneBucket(full.prompts)
  };
  if (utf8ByteLength(JSON.stringify(normalizedFull)) <= byteLimit) {
    return normalizedFull;
  }

  // 超出字节上限时保留最新删除记录，丢弃最旧记录。
  entries.sort((a, b) =>
    b.deletedAt - a.deletedAt || compareAscii(a.bucket, b.bucket) || compareAscii(a.id, b.id)
  );

  const bounded = createEmptyTombstones();
  for (const entry of entries) {
    bounded[entry.bucket][entry.id] = entry.deletedAt;
    if (utf8ByteLength(JSON.stringify(bounded)) > byteLimit) {
      delete bounded[entry.bucket][entry.id];
      break;
    }
  }

  return {
    projects: sortTombstoneBucket(bounded.projects),
    chats: sortTombstoneBucket(bounded.chats),
    prompts: sortTombstoneBucket(bounded.prompts)
  };
}

export function hasAnyTombstones(tombstones: SyncTombstones): boolean {
  return (
    Object.keys(tombstones.projects).length > 0 ||
    Object.keys(tombstones.chats).length > 0 ||
    Object.keys(tombstones.prompts).length > 0
  );
}

export function extractSyncSnapshot(
  state: StoredState,
  promptsData: PromptsData | null,
  tombstones: SyncTombstones,
  now: number,
  tombstonesByteLimit = DRIVE_TOMBSTONES_BYTE_LIMIT
): SyncSnapshot {
  const projects = sortSyncProjects(state.projects.map(projectToSync));
  const chats: SyncChat[] = [];
  for (const chat of Object.values(state.chatIndex)) {
    const compact = chatToSync(chat);
    if (compact) chats.push(compact);
  }
  const prompts = promptsData
    ? sortSyncPrompts(Object.values(promptsData.prompts).map(promptToSync))
    : [];

  return {
    projects,
    chats: sortSyncChats(chats),
    prompts,
    tombstones: pruneAndBoundTombstones(tombstones, now, tombstonesByteLimit)
  };
}

function fnv1a32(bytes: Uint8Array, seed: number): string {
  let hash = seed >>> 0;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function computeSnapshotHash(snapshot: SyncSnapshot): string {
  const canonical = JSON.stringify([
    sortSyncProjects(snapshot.projects),
    sortSyncChats(snapshot.chats),
    sortSyncPrompts(snapshot.prompts),
    {
      projects: sortTombstoneBucket(snapshot.tombstones.projects),
      chats: sortTombstoneBucket(snapshot.tombstones.chats),
      prompts: sortTombstoneBucket(snapshot.tombstones.prompts)
    }
  ]);
  const bytes = utf8Encoder.encode(canonical);
  return fnv1a32(bytes, 0x811c9dc5) + fnv1a32(bytes, 0x9e3779b1);
}

function sanitizeSyncProject(raw: unknown, fallbackIndex: number): SyncProject | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)) return null;
  if (raw.iconStyle !== undefined && !isProjectIconStyle(raw.iconStyle)) return null;
  if (raw.color != null && !isProjectColor(raw.color)) return null;
  const project = sanitizeProject(raw, fallbackIndex, DEFAULT_PROJECT_ICON_STYLE, true);
  if (!project) return null;
  return projectToSync(project);
}

function sanitizeSyncChat(raw: unknown): SyncChat | null {
  if (!isRecord(raw)) return null;
  if (!isSafeId(raw.id) || !isSafeId(raw.projectId)) return null;
  if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)) return null;
  if (raw.lastUrl !== undefined && raw.lastUrl !== null) {
    if (normalizeChatUrl(raw.lastUrl, raw.id) === undefined) return null;
  }
  const title = typeof raw.title === 'string' ? capString(raw.title, SYNC_CHAT_TITLE_MAX_LEN) : '';
  const lastUrl = normalizeChatUrl(raw.lastUrl, raw.id);
  const out: SyncChat = {
    id: raw.id,
    projectId: raw.projectId,
    title,
    updatedAt: raw.updatedAt
  };
  if (lastUrl) out.lastUrl = lastUrl;
  if (raw.isPinned === true) out.isPinned = true;
  return out;
}

function sanitizeSyncPrompt(raw: unknown): SyncPrompt | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)) return null;
  if (typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt)) return null;
  const prompt = sanitizePrompt(raw, undefined, true);
  if (!prompt) return null;
  return promptToSync(prompt);
}

export function sanitizeTombstones(raw: unknown): SyncTombstones {
  const result = createEmptyTombstones();
  if (!isRecord(raw)) return result;

  for (const bucket of ['projects', 'chats', 'prompts'] as const) {
    const source = raw[bucket];
    if (!isRecord(source)) continue;
    for (const [id, value] of Object.entries(source)) {
      if (!isSafeId(id)) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
      result[bucket][id] = value;
    }
  }
  return result;
}

export function parseDriveSyncEnvelope(raw: unknown): ParsedDriveEnvelope {
  if (!isRecord(raw)) return { kind: 'invalid', reason: 'Invalid Google Drive sync payload.' };
  if (raw.v !== SYNC_SCHEMA_VERSION) return { kind: 'invalid', reason: 'Unsupported Google Drive sync version.' };
  if (!isSafeId(raw.clientId)) return { kind: 'invalid', reason: 'Invalid Google Drive sync metadata.' };
  if (typeof raw.rev !== 'number' || !Number.isInteger(raw.rev) || raw.rev < 0) {
    return { kind: 'invalid', reason: 'Invalid Google Drive sync revision.' };
  }
  if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt) || raw.updatedAt < 0) {
    return { kind: 'invalid', reason: 'Invalid Google Drive sync timestamp.' };
  }
  if (typeof raw.hash !== 'string' || !/^[a-f0-9]{8,64}$/i.test(raw.hash)) {
    return { kind: 'invalid', reason: 'Invalid Google Drive sync checksum.' };
  }
  if (!isRecord(raw.snapshot)) {
    return { kind: 'invalid', reason: 'Invalid Google Drive sync snapshot.' };
  }
  if (!Array.isArray(raw.snapshot.projects) || !Array.isArray(raw.snapshot.chats) || !Array.isArray(raw.snapshot.prompts)) {
    return { kind: 'invalid', reason: 'Invalid Google Drive sync collections.' };
  }

  const projects: SyncProject[] = [];
  const seenProjects = new Set<string>();
  for (const entry of raw.snapshot.projects) {
    const sanitized = sanitizeSyncProject(entry, projects.length);
    if (!sanitized || seenProjects.has(sanitized.id)) continue;
    seenProjects.add(sanitized.id);
    projects.push(sanitized);
  }

  const chats: SyncChat[] = [];
  const seenChats = new Set<string>();
  for (const entry of raw.snapshot.chats) {
    const sanitized = sanitizeSyncChat(entry);
    if (!sanitized || seenChats.has(sanitized.id)) continue;
    seenChats.add(sanitized.id);
    chats.push(sanitized);
  }

  const prompts: SyncPrompt[] = [];
  const seenPrompts = new Set<string>();
  for (const entry of raw.snapshot.prompts) {
    const sanitized = sanitizeSyncPrompt(entry);
    if (!sanitized || seenPrompts.has(sanitized.id)) continue;
    seenPrompts.add(sanitized.id);
    prompts.push(sanitized);
  }

  const tombstones = sanitizeTombstones(raw.snapshot.tombstones);
  const snapshot: SyncSnapshot = { projects, chats, prompts, tombstones };

  return {
    kind: 'valid',
    envelope: {
      v: 1,
      clientId: raw.clientId,
      rev: raw.rev,
      updatedAt: raw.updatedAt,
      hash: computeSnapshotHash(snapshot),
      snapshot
    }
  };
}

function isValidDriveFileId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{4,256}$/.test(value);
}

export function sanitizeLocalMeta(
  raw: unknown,
  fallbackClientId: string,
  available: boolean
): SyncLocalMeta {
  if (!isRecord(raw)) return createDefaultLocalMeta(fallbackClientId, available, false);

  // 兼容迁移旧开发版保存的 provider 字段（google_drive -> enabled: true；browser -> enabled: false）。
  const legacyProvider = typeof raw.provider === 'string' ? raw.provider : null;
  const isLegacyDrive = legacyProvider === 'google_drive';
  const isLegacyBrowser = legacyProvider === 'browser';

  const enabled = isLegacyDrive
    ? true
    : isLegacyBrowser
      ? false
      : typeof raw.enabled === 'boolean'
        ? raw.enabled
        : false;

  const clientId = isSafeId(raw.clientId) ? raw.clientId : fallbackClientId;
  const driveFileId = isValidDriveFileId(raw.driveFileId) ? raw.driveFileId : undefined;
  const driveLastModifiedTime =
    typeof raw.driveLastModifiedTime === 'string' && raw.driveLastModifiedTime.length > 0
      ? raw.driveLastModifiedTime
      : undefined;
  const rawVersion = typeof raw.driveLastVersion === 'string' ? raw.driveLastVersion.trim() : '';
  const driveLastVersion = rawVersion.length > 0 && rawVersion.length <= 64 ? rawVersion : undefined;

  const rawRev = legacyProvider !== null ? raw.driveLastSyncedRev : raw.lastSyncedRev;
  const lastSyncedRev =
    typeof rawRev === 'number' && Number.isInteger(rawRev) && rawRev >= 0 ? rawRev : 0;

  const rawHash = legacyProvider !== null ? raw.driveLastSyncedHash : raw.lastSyncedHash;
  const lastSyncedHash = typeof rawHash === 'string' ? rawHash : '';

  const rawAt = legacyProvider !== null ? raw.driveLastSyncedAt : raw.lastSyncedAt;
  const lastSyncedAt =
    typeof rawAt === 'number' && Number.isFinite(rawAt) ? rawAt : null;

  const tombstones = sanitizeTombstones(raw.tombstones);

  const rawStatus = isRecord(raw.status) ? raw.status : null;
  const validStates: CloudSyncState[] = [
    'disabled', 'syncing', 'synced', 'auth_expired', 'unavailable', 'error'
  ];
  let state: CloudSyncState =
    rawStatus && typeof rawStatus.state === 'string' && validStates.includes(rawStatus.state as CloudSyncState)
      ? (rawStatus.state as CloudSyncState)
      : (enabled ? 'synced' : 'disabled');

  if (!available) {
    state = 'unavailable';
  } else if (!enabled) {
    state = 'disabled';
  } else if (state === 'syncing' || state === 'disabled' || state === 'unavailable') {
    state = 'synced';
  }

  const status: CloudSyncStatus = {
    enabled,
    available,
    state,
    lastSyncedAt
  };
  if (
    (state === 'error' || state === 'auth_expired') &&
    rawStatus &&
    typeof rawStatus.lastError === 'string' &&
    rawStatus.lastError
  ) {
    status.lastError = rawStatus.lastError;
  }
  if (
    enabled &&
    !isLegacyBrowser &&
    rawStatus &&
    typeof rawStatus.bytesUsed === 'number' &&
    Number.isFinite(rawStatus.bytesUsed) &&
    rawStatus.bytesUsed >= 0
  ) {
    status.bytesUsed = rawStatus.bytesUsed;
  }

  return {
    enabled,
    clientId,
    ...(driveFileId ? { driveFileId } : {}),
    ...(driveLastModifiedTime ? { driveLastModifiedTime } : {}),
    ...(driveLastVersion ? { driveLastVersion } : {}),
    lastSyncedRev,
    lastSyncedHash,
    lastSyncedAt,
    tombstones,
    status
  };
}

function canonicalProjectKey(p: SyncProject): string {
  return JSON.stringify([
    p.id, p.name, p.icon, p.iconStyle, p.color ?? '',
    p.useIconPalette === true, p.isPinned === true, p.createdAt, p.updatedAt, p.sortIndex
  ]);
}

function canonicalChatKey(c: SyncChat): string {
  return JSON.stringify([c.id, c.projectId, c.title, c.lastUrl ?? '', c.isPinned === true, c.updatedAt]);
}

function canonicalPromptKey(p: SyncPrompt): string {
  return JSON.stringify([p.id, p.title, p.content, p.createdAt, p.updatedAt]);
}

// 确定性且可交换的 LWW 胜出选择，保证双端合并结果完全一致。
function pickWinner<T extends { updatedAt: number }>(
  a: T | undefined,
  b: T | undefined,
  canonicalize: (item: T) => string
): T | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  return canonicalize(a) >= canonicalize(b) ? a : b;
}

function syncProjectToLocal(p: SyncProject): Project {
  return {
    id: p.id,
    name: p.name,
    icon: p.icon,
    iconStyle: p.iconStyle,
    color: p.color,
    useIconPalette: p.useIconPalette,
    isPinned: p.isPinned === true,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    sortIndex: p.sortIndex
  };
}

export function mergeSyncData(
  localState: StoredState,
  localPrompts: PromptsData,
  localTombstones: SyncTombstones,
  remote: SyncSnapshot,
  now: number,
  tombstonesByteLimit = DRIVE_TOMBSTONES_BYTE_LIMIT
): MergeResult {
  const mergedTombstones = createEmptyTombstones();

  // 1. 合并 Projects
  const localProjectMap = new Map<string, SyncProject>();
  for (const p of localState.projects) localProjectMap.set(p.id, projectToSync(p));
  const remoteProjectMap = new Map<string, SyncProject>();
  for (const p of remote.projects) remoteProjectMap.set(p.id, p);

  const allProjectIds = new Set<string>([
    ...localProjectMap.keys(),
    ...remoteProjectMap.keys(),
    ...Object.keys(localTombstones.projects),
    ...Object.keys(remote.tombstones.projects)
  ]);

  const mergedProjects: Project[] = [];
  const survivingProjectIds = new Set<string>();

  for (const id of allProjectIds) {
    if (!isSafeId(id)) continue;
    const tombstone = Math.max(
      Object.hasOwn(localTombstones.projects, id) ? localTombstones.projects[id] : 0,
      Object.hasOwn(remote.tombstones.projects, id) ? remote.tombstones.projects[id] : 0
    );
    const winner = pickWinner(localProjectMap.get(id), remoteProjectMap.get(id), canonicalProjectKey);

    if (!winner) {
      if (tombstone > 0) mergedTombstones.projects[id] = tombstone;
      continue;
    }

    if (tombstone >= winner.updatedAt) {
      mergedTombstones.projects[id] = tombstone;
    } else {
      mergedProjects.push(syncProjectToLocal(winner));
      survivingProjectIds.add(id);
    }
  }

  mergedProjects.sort((a, b) =>
    a.sortIndex - b.sortIndex || a.createdAt - b.createdAt || compareAscii(a.id, b.id)
  );

  // 2. 合并 Chats（未归属聊天仅保留在本地，不参与远端删除）
  const remoteChatMap = new Map<string, SyncChat>();
  for (const c of remote.chats) remoteChatMap.set(c.id, c);

  const allChatIds = new Set<string>([
    ...Object.keys(localState.chatIndex),
    ...remoteChatMap.keys(),
    ...Object.keys(localTombstones.chats),
    ...Object.keys(remote.tombstones.chats)
  ]);

  const mergedChatIndex: Record<string, ChatRef> = {};

  for (const id of allChatIds) {
    if (!isSafeId(id)) continue;
    const localChat = Object.hasOwn(localState.chatIndex, id) ? localState.chatIndex[id] : undefined;
    const localAssigned = localChat ? chatToSync(localChat) : null;
    const remoteChat = remoteChatMap.get(id);
    const tombstone = Math.max(
      Object.hasOwn(localTombstones.chats, id) ? localTombstones.chats[id] : 0,
      Object.hasOwn(remote.tombstones.chats, id) ? remote.tombstones.chats[id] : 0
    );

    if (localAssigned && remoteChat) {
      const winner = pickWinner(localAssigned, remoteChat, canonicalChatKey)!;
      if (tombstone >= winner.updatedAt) {
        mergedTombstones.chats[id] = tombstone;
        mergedChatIndex[id] = {
          conversationId: id,
          title: winner.title || localChat?.title || '',
          isPinned: winner.isPinned ?? localChat?.isPinned ?? false,
          projectId: null,
          updatedAt: Math.max(winner.updatedAt, tombstone),
          lastUrl: winner.lastUrl ?? localChat?.lastUrl
        };
      } else {
        mergedChatIndex[id] = {
          conversationId: id,
          title: winner.title || localChat?.title || '',
          isPinned: winner.isPinned ?? localChat?.isPinned ?? false,
          projectId: winner.projectId,
          updatedAt: winner.updatedAt,
          lastUrl: winner.lastUrl ?? localChat?.lastUrl
        };
      }
    } else if (!localAssigned && remoteChat) {
      if (tombstone >= remoteChat.updatedAt) {
        mergedTombstones.chats[id] = tombstone;
        if (localChat) mergedChatIndex[id] = localChat;
      } else {
        mergedChatIndex[id] = {
          conversationId: id,
          title: remoteChat.title || localChat?.title || '',
          isPinned: remoteChat.isPinned ?? localChat?.isPinned ?? false,
          projectId: remoteChat.projectId,
          updatedAt: remoteChat.updatedAt,
          lastUrl: remoteChat.lastUrl ?? localChat?.lastUrl
        };
      }
    } else if (localAssigned && !remoteChat) {
      if (tombstone >= localAssigned.updatedAt) {
        mergedTombstones.chats[id] = tombstone;
        mergedChatIndex[id] = {
          ...localChat!,
          projectId: null,
          updatedAt: Math.max(localAssigned.updatedAt, tombstone)
        };
      } else {
        mergedChatIndex[id] = localChat!;
      }
    } else {
      // 双方均未归属（本地未归属聊天保持原样，墓碑按 TTL 保留）
      if (localChat) mergedChatIndex[id] = localChat;
      if (tombstone > 0) mergedTombstones.chats[id] = tombstone;
    }
  }

  // 引用完整性：目标项目已被删除或缺失的聊天回退为未归属，保留其标题与链接。
  for (const chat of Object.values(mergedChatIndex)) {
    if (chat.projectId && !survivingProjectIds.has(chat.projectId)) {
      mergedChatIndex[chat.conversationId] = { ...chat, projectId: null };
    }
  }

  // 3. 合并 Prompts（usageCount 与 lastUsedAt 严格保持本地）
  const localPromptMap = new Map<string, SyncPrompt>();
  for (const p of Object.values(localPrompts.prompts)) localPromptMap.set(p.id, promptToSync(p));
  const remotePromptMap = new Map<string, SyncPrompt>();
  for (const p of remote.prompts) remotePromptMap.set(p.id, p);

  const allPromptIds = new Set<string>([
    ...localPromptMap.keys(),
    ...remotePromptMap.keys(),
    ...Object.keys(localTombstones.prompts),
    ...Object.keys(remote.tombstones.prompts)
  ]);

  const mergedPromptsMap: Record<string, Prompt> = {};

  for (const id of allPromptIds) {
    if (!isSafeId(id)) continue;
    const tombstone = Math.max(
      Object.hasOwn(localTombstones.prompts, id) ? localTombstones.prompts[id] : 0,
      Object.hasOwn(remote.tombstones.prompts, id) ? remote.tombstones.prompts[id] : 0
    );
    const localFull = Object.hasOwn(localPrompts.prompts, id) ? localPrompts.prompts[id] : undefined;
    const winner = pickWinner(localPromptMap.get(id), remotePromptMap.get(id), canonicalPromptKey);

    if (!winner) {
      if (tombstone > 0) mergedTombstones.prompts[id] = tombstone;
      continue;
    }

    if (tombstone >= winner.updatedAt) {
      mergedTombstones.prompts[id] = tombstone;
    } else {
      mergedPromptsMap[id] = {
        id: winner.id,
        title: winner.title,
        content: winner.content,
        createdAt: winner.createdAt,
        updatedAt: winner.updatedAt,
        usageCount: localFull?.usageCount ?? 0,
        lastUsedAt: localFull?.lastUsedAt ?? 0
      };
    }
  }

  const nextState: StoredState = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projects: mergedProjects,
    chatIndex: mergedChatIndex,
    uiPrefs: { projectsCollapsed: localState.uiPrefs.projectsCollapsed }
  };

  const nextPrompts: PromptsData = {
    prompts: mergedPromptsMap,
    version: 1
  };

  const prunedTombstones = pruneAndBoundTombstones(mergedTombstones, now, tombstonesByteLimit);

  return {
    state: nextState,
    prompts: nextPrompts,
    tombstones: prunedTombstones,
    stateChanged: JSON.stringify(nextState) !== JSON.stringify(localState),
    promptsChanged: JSON.stringify(nextPrompts) !== JSON.stringify(localPrompts)
  };
}
