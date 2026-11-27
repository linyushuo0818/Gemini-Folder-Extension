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

export const SYNC_PREFIX = 'gp_sync_v1_';
export const SYNC_META_KEY = 'gp_sync_v1_meta';
export const SYNC_PROJECTS_PREFIX = 'gp_sync_v1_projects_';
export const SYNC_CHATS_PREFIX = 'gp_sync_v1_chats_';
export const SYNC_PROMPTS_PREFIX = 'gp_sync_v1_prompts_';
export const SYNC_TOMBSTONES_KEY = 'gp_sync_v1_tombstones';
export const SYNC_LOCAL_META_KEY = 'gp_sync_local_meta_v1';
export const SYNC_SCHEMA_VERSION = 1;

// 保守安全上限（低于 Chrome 的 8,192 B/项、102,400 B 总量、512 项限制）。
export const SYNC_ITEM_BYTE_LIMIT = 7000;
export const SYNC_TOTAL_BYTE_LIMIT = 92000;
export const SYNC_MAX_ITEMS = 450;
export const SYNC_TOMBSTONES_BYTE_LIMIT = 6500;
export const SYNC_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SYNC_CHAT_TITLE_MAX_LEN = 200;

const SYNC_META_RESERVED_BYTES = 350;

export interface SyncMeta {
  v: 1;
  clientId: string;
  rev: number;
  updatedAt: number;
  hash: string;
  shards: {
    projects: number;
    chats: number;
    prompts: number;
    tombstones: number;
  };
}

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
  | 'idle'
  | 'syncing'
  | 'synced'
  | 'disabled'
  | 'partial'
  | 'quota_exceeded'
  | 'unavailable'
  | 'error';

export interface CloudSyncStatus {
  enabled: boolean;
  available: boolean;
  state: CloudSyncState;
  lastSyncedAt: number | null;
  lastError?: string;
  omittedChats?: number;
  omittedPrompts?: number;
  bytesUsed?: number;
  bytesLimit: number;
}

export interface SyncLocalMeta {
  enabled: boolean;
  clientId: string;
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

export interface PackedSyncPayload {
  items: Record<string, unknown>;
  meta: SyncMeta;
  hash: string;
  bytesUsed: number;
  omittedProjects: number;
  omittedChats: number;
  omittedPrompts: number;
}

export type ParsedRemoteSync =
  | { kind: 'empty' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'valid'; meta: SyncMeta; snapshot: SyncSnapshot };

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

// 与 Chrome storage.sync 一致：key 字节数 + JSON.stringify(value) 字节数。
export function syncEntryByteSize(key: string, value: unknown): number {
  return utf8ByteLength(key) + utf8ByteLength(JSON.stringify(value));
}

export function createEmptyTombstones(): SyncTombstones {
  return { projects: {}, chats: {}, prompts: {} };
}

export function createDefaultSyncStatus(available = true, enabled = true): CloudSyncStatus {
  return {
    enabled,
    available,
    state: !available ? 'unavailable' : enabled ? 'idle' : 'disabled',
    lastSyncedAt: null,
    bytesLimit: SYNC_TOTAL_BYTE_LIMIT
  };
}

export function createDefaultLocalMeta(
  clientId: string,
  available = true,
  enabled = true
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
  byteLimit = SYNC_TOMBSTONES_BYTE_LIMIT
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
  if (syncEntryByteSize(SYNC_TOMBSTONES_KEY, normalizedFull) <= byteLimit) {
    return normalizedFull;
  }

  // 超出字节上限时保留最新删除记录，丢弃最旧记录。
  entries.sort((a, b) =>
    b.deletedAt - a.deletedAt || compareAscii(a.bucket, b.bucket) || compareAscii(a.id, b.id)
  );

  const bounded = createEmptyTombstones();
  for (const entry of entries) {
    bounded[entry.bucket][entry.id] = entry.deletedAt;
    if (syncEntryByteSize(SYNC_TOMBSTONES_KEY, bounded) > byteLimit) {
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
  now: number
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
    tombstones: pruneAndBoundTombstones(tombstones, now)
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

interface ShardPackResult<T> {
  shards: T[][];
  packedItems: T[];
  omittedCount: number;
  remainingBytes: number;
  remainingKeys: number;
}

function packCategoryIntoShards<T>(
  items: T[],
  keyPrefix: string,
  initialRemainingBytes: number,
  initialRemainingKeys: number,
  skipOversizedSingle: boolean
): ShardPackResult<T> {
  const shards: T[][] = [];
  const packedItems: T[] = [];
  let currentShard: T[] = [];
  let currentShardSize = 0;
  let remainingBytes = initialRemainingBytes;
  let remainingKeys = initialRemainingKeys;
  let omittedCount = 0;

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const currentKey = `${keyPrefix}${shards.length}`;
    const singleSize = syncEntryByteSize(currentKey, [item]);

    if (singleSize > SYNC_ITEM_BYTE_LIMIT) {
      omittedCount += 1;
      if (skipOversizedSingle) continue;
      continue;
    }

    if (currentShard.length > 0) {
      const candidate = [...currentShard, item];
      const candidateSize = syncEntryByteSize(currentKey, candidate);
      if (candidateSize <= SYNC_ITEM_BYTE_LIMIT) {
        const delta = candidateSize - currentShardSize;
        if (delta <= remainingBytes) {
          currentShard.push(item);
          packedItems.push(item);
          remainingBytes -= delta;
          currentShardSize = candidateSize;
          continue;
        }
        // 总字节配额已满，跳过当前及后续项（单条超大已在上方跳过）。
        omittedCount += items.length - i;
        break;
      }
      // 当前分片容量不足，落盘并尝试开启新分片。
      shards.push(currentShard);
      currentShard = [];
      currentShardSize = 0;
    }

    const nextKey = `${keyPrefix}${shards.length}`;
    const nextSingleSize = syncEntryByteSize(nextKey, [item]);
    if (nextSingleSize > SYNC_ITEM_BYTE_LIMIT) {
      omittedCount += 1;
      continue;
    }
    if (remainingKeys < 1 || nextSingleSize > remainingBytes) {
      omittedCount += items.length - i;
      break;
    }
    currentShard = [item];
    currentShardSize = nextSingleSize;
    remainingBytes -= nextSingleSize;
    remainingKeys -= 1;
    packedItems.push(item);
  }

  if (currentShard.length > 0) {
    shards.push(currentShard);
  }

  return { shards, packedItems, omittedCount, remainingBytes, remainingKeys };
}

export function packSyncPayload(
  snapshot: SyncSnapshot,
  params: { clientId: string; rev: number; updatedAt: number }
): PackedSyncPayload {
  const tombstones = pruneAndBoundTombstones(snapshot.tombstones, params.updatedAt);
  const items: Record<string, unknown> = {};

  let remainingBytes = SYNC_TOTAL_BYTE_LIMIT - SYNC_META_RESERVED_BYTES;
  let remainingKeys = SYNC_MAX_ITEMS - 1;

  // (1) Meta + Tombstones
  let tombstoneShards = 0;
  if (hasAnyTombstones(tombstones)) {
    const tombstoneBytes = syncEntryByteSize(SYNC_TOMBSTONES_KEY, tombstones);
    if (tombstoneBytes <= remainingBytes && remainingKeys >= 1) {
      items[SYNC_TOMBSTONES_KEY] = tombstones;
      remainingBytes -= tombstoneBytes;
      remainingKeys -= 1;
      tombstoneShards = 1;
    }
  }

  // (2) Projects（确定性顺序）
  const packedProjects = packCategoryIntoShards(
    sortSyncProjects(snapshot.projects),
    SYNC_PROJECTS_PREFIX,
    remainingBytes,
    remainingKeys,
    false
  );
  remainingBytes = packedProjects.remainingBytes;
  remainingKeys = packedProjects.remainingKeys;
  packedProjects.shards.forEach((shard, index) => {
    items[`${SYNC_PROJECTS_PREFIX}${index}`] = shard;
  });

  // (3) Assigned chats（updatedAt DESC, id ASC）
  const packedChats = packCategoryIntoShards(
    sortSyncChats(snapshot.chats),
    SYNC_CHATS_PREFIX,
    remainingBytes,
    remainingKeys,
    false
  );
  remainingBytes = packedChats.remainingBytes;
  remainingKeys = packedChats.remainingKeys;
  packedChats.shards.forEach((shard, index) => {
    items[`${SYNC_CHATS_PREFIX}${index}`] = shard;
  });

  // (4) Prompts（updatedAt DESC, id ASC；单条超过 7,000 B 跳过不阻断）
  const packedPrompts = packCategoryIntoShards(
    sortSyncPrompts(snapshot.prompts),
    SYNC_PROMPTS_PREFIX,
    remainingBytes,
    remainingKeys,
    true
  );
  packedPrompts.shards.forEach((shard, index) => {
    items[`${SYNC_PROMPTS_PREFIX}${index}`] = shard;
  });

  const packedSnapshot: SyncSnapshot = {
    projects: packedProjects.packedItems,
    chats: packedChats.packedItems,
    prompts: packedPrompts.packedItems,
    tombstones: tombstoneShards > 0 ? tombstones : createEmptyTombstones()
  };
  const hash = computeSnapshotHash(packedSnapshot);

  const meta: SyncMeta = {
    v: SYNC_SCHEMA_VERSION,
    clientId: params.clientId,
    rev: params.rev,
    updatedAt: params.updatedAt,
    hash,
    shards: {
      projects: packedProjects.shards.length,
      chats: packedChats.shards.length,
      prompts: packedPrompts.shards.length,
      tombstones: tombstoneShards
    }
  };
  items[SYNC_META_KEY] = meta;

  let bytesUsed = 0;
  for (const [key, value] of Object.entries(items)) {
    bytesUsed += syncEntryByteSize(key, value);
  }

  return {
    items,
    meta,
    hash,
    bytesUsed,
    omittedProjects: packedProjects.omittedCount,
    omittedChats: packedChats.omittedCount,
    omittedPrompts: packedPrompts.omittedCount
  };
}

export function sanitizeSyncMeta(raw: unknown): SyncMeta | null {
  if (!isRecord(raw)) return null;
  if (raw.v !== SYNC_SCHEMA_VERSION) return null;
  if (!isSafeId(raw.clientId)) return null;
  if (typeof raw.rev !== 'number' || !Number.isInteger(raw.rev) || raw.rev < 0) return null;
  if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt) || raw.updatedAt < 0) return null;
  if (typeof raw.hash !== 'string' || !/^[a-f0-9]{8,64}$/i.test(raw.hash)) return null;
  if (!isRecord(raw.shards)) return null;

  const projects = raw.shards.projects;
  const chats = raw.shards.chats;
  const prompts = raw.shards.prompts;
  const tombstones = raw.shards.tombstones;
  const isShardCount = (v: unknown): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 512;
  if (!isShardCount(projects) || !isShardCount(chats) || !isShardCount(prompts) || !isShardCount(tombstones)) {
    return null;
  }

  return {
    v: 1,
    clientId: raw.clientId,
    rev: raw.rev,
    updatedAt: raw.updatedAt,
    hash: raw.hash,
    shards: { projects, chats, prompts, tombstones }
  };
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

export function parseRemoteSyncData(rawAll: Record<string, unknown>): ParsedRemoteSync {
  const rawMeta = rawAll[SYNC_META_KEY];
  if (rawMeta === undefined) return { kind: 'empty' };

  const meta = sanitizeSyncMeta(rawMeta);
  if (!meta) return { kind: 'invalid', reason: 'Invalid sync metadata.' };

  const projects: SyncProject[] = [];
  const seenProjects = new Set<string>();
  for (let i = 0; i < meta.shards.projects; i += 1) {
    const shard = rawAll[`${SYNC_PROJECTS_PREFIX}${i}`];
    if (!Array.isArray(shard)) continue;
    for (const entry of shard) {
      const sanitized = sanitizeSyncProject(entry, projects.length);
      if (!sanitized || seenProjects.has(sanitized.id)) continue;
      seenProjects.add(sanitized.id);
      projects.push(sanitized);
    }
  }

  const chats: SyncChat[] = [];
  const seenChats = new Set<string>();
  for (let i = 0; i < meta.shards.chats; i += 1) {
    const shard = rawAll[`${SYNC_CHATS_PREFIX}${i}`];
    if (!Array.isArray(shard)) continue;
    for (const entry of shard) {
      const sanitized = sanitizeSyncChat(entry);
      if (!sanitized || seenChats.has(sanitized.id)) continue;
      seenChats.add(sanitized.id);
      chats.push(sanitized);
    }
  }

  const prompts: SyncPrompt[] = [];
  const seenPrompts = new Set<string>();
  for (let i = 0; i < meta.shards.prompts; i += 1) {
    const shard = rawAll[`${SYNC_PROMPTS_PREFIX}${i}`];
    if (!Array.isArray(shard)) continue;
    for (const entry of shard) {
      const sanitized = sanitizeSyncPrompt(entry);
      if (!sanitized || seenPrompts.has(sanitized.id)) continue;
      seenPrompts.add(sanitized.id);
      prompts.push(sanitized);
    }
  }

  const tombstones = meta.shards.tombstones > 0
    ? sanitizeTombstones(rawAll[SYNC_TOMBSTONES_KEY])
    : createEmptyTombstones();

  return {
    kind: 'valid',
    meta,
    snapshot: { projects, chats, prompts, tombstones }
  };
}

export function sanitizeLocalMeta(
  raw: unknown,
  fallbackClientId: string,
  available: boolean
): SyncLocalMeta {
  if (!isRecord(raw)) return createDefaultLocalMeta(fallbackClientId, available, true);
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : true;
  const clientId = isSafeId(raw.clientId) ? raw.clientId : fallbackClientId;
  const lastSyncedRev = typeof raw.lastSyncedRev === 'number' && Number.isInteger(raw.lastSyncedRev) && raw.lastSyncedRev >= 0
    ? raw.lastSyncedRev
    : 0;
  const lastSyncedHash = typeof raw.lastSyncedHash === 'string' ? raw.lastSyncedHash : '';
  const lastSyncedAt = typeof raw.lastSyncedAt === 'number' && Number.isFinite(raw.lastSyncedAt)
    ? raw.lastSyncedAt
    : null;
  const tombstones = sanitizeTombstones(raw.tombstones);

  const rawStatus = isRecord(raw.status) ? raw.status : null;
  const validStates: CloudSyncState[] = [
    'idle', 'syncing', 'synced', 'disabled', 'partial', 'quota_exceeded', 'unavailable', 'error'
  ];
  let state: CloudSyncState = rawStatus && typeof rawStatus.state === 'string' && validStates.includes(rawStatus.state as CloudSyncState)
    ? (rawStatus.state as CloudSyncState)
    : (enabled ? 'idle' : 'disabled');
  if (!available) state = 'unavailable';
  else if (!enabled) state = 'disabled';
  else if (state === 'syncing') state = 'idle';

  const status: CloudSyncStatus = {
    enabled,
    available,
    state,
    lastSyncedAt,
    bytesLimit: SYNC_TOTAL_BYTE_LIMIT
  };
  if (rawStatus && typeof rawStatus.lastError === 'string' && rawStatus.lastError) {
    status.lastError = rawStatus.lastError;
  }
  if (rawStatus && typeof rawStatus.omittedChats === 'number' && Number.isFinite(rawStatus.omittedChats) && rawStatus.omittedChats > 0) {
    status.omittedChats = rawStatus.omittedChats;
  }
  if (rawStatus && typeof rawStatus.omittedPrompts === 'number' && Number.isFinite(rawStatus.omittedPrompts) && rawStatus.omittedPrompts > 0) {
    status.omittedPrompts = rawStatus.omittedPrompts;
  }
  if (rawStatus && typeof rawStatus.bytesUsed === 'number' && Number.isFinite(rawStatus.bytesUsed) && rawStatus.bytesUsed >= 0) {
    status.bytesUsed = rawStatus.bytesUsed;
  }

  return {
    enabled,
    clientId,
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
  now: number
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

  const prunedTombstones = pruneAndBoundTombstones(mergedTombstones, now);

  return {
    state: nextState,
    prompts: nextPrompts,
    tombstones: prunedTombstones,
    stateChanged: JSON.stringify(nextState) !== JSON.stringify(localState),
    promptsChanged: JSON.stringify(nextPrompts) !== JSON.stringify(localPrompts)
  };
}
