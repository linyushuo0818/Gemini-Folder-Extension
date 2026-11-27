import { PromptsData } from '../shared/prompts';
import { StoredState } from '../shared/types';
import {
  CloudSyncStatus,
  createDefaultLocalMeta,
  extractSyncSnapshot,
  mergeSyncData,
  PackedSyncPayload,
  packSyncPayload,
  parseRemoteSyncData,
  pruneAndBoundTombstones,
  sanitizeLocalMeta,
  sanitizeSyncMeta,
  SYNC_LOCAL_META_KEY,
  SYNC_META_KEY,
  SYNC_PREFIX,
  SYNC_TOTAL_BYTE_LIMIT,
  SyncLocalMeta
} from '../shared/sync';

export interface StorageAreaLike {
  get: (keys?: string | string[] | Record<string, unknown> | null) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
  remove: (keys: string | string[]) => Promise<void>;
}

export interface LocalDataSnapshot {
  hasLocalProjects: boolean;
  hasLocalPrompts: boolean;
  state: StoredState;
  prompts: PromptsData;
}

export interface CloudSyncStoreHooks {
  readRawLocalSnapshot: () => Promise<LocalDataSnapshot>;
  applyPulledData: (next: { state?: StoredState; prompts?: PromptsData }) => Promise<void>;
  runSerialized: <T>(task: () => Promise<T>) => Promise<T>;
}

export interface CloudSyncOptions {
  local: StorageAreaLike;
  sync: StorageAreaLike | null;
  hooks: CloudSyncStoreHooks;
  now?: () => number;
  randomUUID?: () => string;
  debounceMs?: number;
}

export interface SyncActionResult {
  ok: boolean;
  error?: string;
  status: CloudSyncStatus;
}

const DEFAULT_DEBOUNCE_MS = 1500;

function isRateLimitError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? '');
  return /MAX_WRITE_OPERATIONS/i.test(msg);
}

function isQuotaError(error: unknown): boolean {
  if (isRateLimitError(error)) return false;
  const msg = error instanceof Error ? error.message : String(error ?? '');
  return /QUOTA_BYTES|MAX_ITEMS|quota/i.test(msg);
}

function classifyError(error: unknown): { state: 'quota_exceeded' | 'error'; message: string } {
  if (isRateLimitError(error)) {
    return {
      state: 'error',
      message: 'Chrome Sync rate limit reached. Will sync on next change.'
    };
  }
  if (isQuotaError(error)) {
    return {
      state: 'quota_exceeded',
      message: 'Chrome Sync storage is full. Your data is still saved locally.'
    };
  }
  return {
    state: 'error',
    message: error instanceof Error && error.message ? error.message : 'Chrome Sync failed.'
  };
}

function buildStatusFromPack(
  meta: SyncLocalMeta,
  available: boolean,
  packed: PackedSyncPayload,
  syncedAt: number
): CloudSyncStatus {
  const isPartial = packed.omittedProjects > 0 || packed.omittedChats > 0 || packed.omittedPrompts > 0;
  const status: CloudSyncStatus = {
    enabled: meta.enabled,
    available,
    state: isPartial ? 'partial' : 'synced',
    lastSyncedAt: syncedAt,
    bytesUsed: packed.bytesUsed,
    bytesLimit: SYNC_TOTAL_BYTE_LIMIT
  };
  if (packed.omittedChats > 0) status.omittedChats = packed.omittedChats;
  if (packed.omittedPrompts > 0) status.omittedPrompts = packed.omittedPrompts;
  return status;
}

export class CloudSyncManager {
  private readonly local: StorageAreaLike;
  private readonly sync: StorageAreaLike | null;
  private readonly hooks: CloudSyncStoreHooks;
  private readonly clockNow: () => number;
  private readonly generateId: () => string;
  private readonly debounceMs: number;

  private localMeta: SyncLocalMeta | null = null;
  private initialized = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: CloudSyncOptions) {
    this.local = options.local;
    this.sync = options.sync;
    this.hooks = options.hooks;
    this.clockNow = options.now ?? (() => Date.now());
    this.generateId = options.randomUUID ?? (() => crypto.randomUUID());
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  private get available(): boolean {
    return this.sync !== null;
  }

  private async ensureMetaLoaded(): Promise<SyncLocalMeta> {
    if (this.localMeta) return this.localMeta;
    const raw = (await this.local.get(SYNC_LOCAL_META_KEY))[SYNC_LOCAL_META_KEY];
    if (raw === undefined) {
      const fresh = createDefaultLocalMeta(this.generateId(), this.available, true);
      await this.local.set({ [SYNC_LOCAL_META_KEY]: fresh });
      this.localMeta = fresh;
      return fresh;
    }
    const normalized = sanitizeLocalMeta(raw, this.generateId(), this.available);
    this.localMeta = normalized;
    return normalized;
  }

  private async persistMeta(meta: SyncLocalMeta): Promise<void> {
    this.localMeta = meta;
    await this.local.set({ [SYNC_LOCAL_META_KEY]: meta });
  }

  public async getStatus(): Promise<CloudSyncStatus> {
    const meta = await this.ensureMetaLoaded();
    return { ...meta.status };
  }

  public async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    const meta = await this.ensureMetaLoaded();
    this.initialized = true;

    if (!this.available) {
      if (meta.status.state !== 'unavailable' || meta.status.available) {
        meta.status = {
          ...meta.status,
          available: false,
          state: 'unavailable',
          lastError: undefined
        };
        await this.persistMeta(meta);
      }
      return;
    }

    if (!meta.enabled) {
      if (meta.status.state !== 'disabled' || meta.status.enabled) {
        meta.status = {
          ...meta.status,
          enabled: false,
          available: true,
          state: 'disabled',
          lastError: undefined
        };
        await this.persistMeta(meta);
      }
      return;
    }

    await this.reconcileWithRemote('init');
  }

  public async recordProjectAlive(projectId: string, now: number): Promise<number> {
    const meta = await this.ensureMetaLoaded();
    const prev = meta.tombstones.projects[projectId] ?? 0;
    const timestamp = Math.max(now, prev + 1);
    if (Object.hasOwn(meta.tombstones.projects, projectId)) {
      delete meta.tombstones.projects[projectId];
      await this.persistMeta(meta);
    }
    return timestamp;
  }

  public async recordProjectDeleted(projectId: string, minTimestamp: number): Promise<void> {
    const meta = await this.ensureMetaLoaded();
    const ts = Math.max(this.clockNow(), minTimestamp);
    meta.tombstones.projects[projectId] = ts;
    meta.tombstones = pruneAndBoundTombstones(meta.tombstones, ts);
    await this.persistMeta(meta);
  }

  public async recordChatAssigned(conversationId: string, now: number): Promise<number> {
    const meta = await this.ensureMetaLoaded();
    const prev = meta.tombstones.chats[conversationId] ?? 0;
    const timestamp = Math.max(now, prev + 1);
    if (Object.hasOwn(meta.tombstones.chats, conversationId)) {
      delete meta.tombstones.chats[conversationId];
      await this.persistMeta(meta);
    }
    return timestamp;
  }

  public async recordChatUnassigned(conversationId: string, minTimestamp: number): Promise<void> {
    const meta = await this.ensureMetaLoaded();
    const ts = Math.max(this.clockNow(), minTimestamp);
    meta.tombstones.chats[conversationId] = ts;
    meta.tombstones = pruneAndBoundTombstones(meta.tombstones, ts);
    await this.persistMeta(meta);
  }

  public async recordPromptAlive(promptId: string, now: number): Promise<number> {
    const meta = await this.ensureMetaLoaded();
    const prev = meta.tombstones.prompts[promptId] ?? 0;
    const timestamp = Math.max(now, prev + 1);
    if (Object.hasOwn(meta.tombstones.prompts, promptId)) {
      delete meta.tombstones.prompts[promptId];
      await this.persistMeta(meta);
    }
    return timestamp;
  }

  public async recordPromptDeleted(promptId: string, minTimestamp: number): Promise<void> {
    const meta = await this.ensureMetaLoaded();
    const ts = Math.max(this.clockNow(), minTimestamp);
    meta.tombstones.prompts[promptId] = ts;
    meta.tombstones = pruneAndBoundTombstones(meta.tombstones, ts);
    await this.persistMeta(meta);
  }

  public async prepareBackupRestore(
    prevState: StoredState,
    prevPrompts: PromptsData | null,
    restoredProjects: StoredState | undefined,
    restoredPrompts: PromptsData | undefined
  ): Promise<{ projects?: StoredState; prompts?: PromptsData; stamp: number }> {
    const meta = await this.ensureMetaLoaded();

    let maxTs = meta.lastSyncedAt ?? 0;
    for (const ts of Object.values(meta.tombstones.projects)) maxTs = Math.max(maxTs, ts);
    for (const ts of Object.values(meta.tombstones.chats)) maxTs = Math.max(maxTs, ts);
    for (const ts of Object.values(meta.tombstones.prompts)) maxTs = Math.max(maxTs, ts);
    for (const p of prevState.projects) maxTs = Math.max(maxTs, p.updatedAt, p.createdAt);
    for (const c of Object.values(prevState.chatIndex)) maxTs = Math.max(maxTs, c.updatedAt);
    if (prevPrompts) {
      for (const p of Object.values(prevPrompts.prompts)) maxTs = Math.max(maxTs, p.updatedAt, p.createdAt);
    }
    if (restoredProjects) {
      for (const p of restoredProjects.projects) maxTs = Math.max(maxTs, p.updatedAt, p.createdAt);
      for (const c of Object.values(restoredProjects.chatIndex)) maxTs = Math.max(maxTs, c.updatedAt);
    }
    if (restoredPrompts) {
      for (const p of Object.values(restoredPrompts.prompts)) maxTs = Math.max(maxTs, p.updatedAt, p.createdAt);
    }

    const stamp = Math.max(this.clockNow(), maxTs + 1);
    let stampedProjects: StoredState | undefined;
    let stampedPrompts: PromptsData | undefined;

    if (restoredProjects) {
      const nextProjectIds = new Set(restoredProjects.projects.map((p) => p.id));
      for (const prev of prevState.projects) {
        if (!nextProjectIds.has(prev.id)) {
          meta.tombstones.projects[prev.id] = stamp;
        }
      }
      for (const id of nextProjectIds) {
        delete meta.tombstones.projects[id];
      }

      const nextAssignedChatIds = new Set<string>();
      const nextChatIndex: StoredState['chatIndex'] = {};
      for (const [id, chat] of Object.entries(restoredProjects.chatIndex)) {
        if (chat.projectId) {
          nextAssignedChatIds.add(id);
          nextChatIndex[id] = { ...chat, updatedAt: stamp };
        } else {
          nextChatIndex[id] = { ...chat };
        }
      }
      for (const [id, prevChat] of Object.entries(prevState.chatIndex)) {
        if (prevChat.projectId && !nextAssignedChatIds.has(id)) {
          meta.tombstones.chats[id] = stamp;
        }
      }
      for (const id of nextAssignedChatIds) {
        delete meta.tombstones.chats[id];
      }

      stampedProjects = {
        ...restoredProjects,
        projects: restoredProjects.projects.map((p) => ({ ...p, updatedAt: stamp })),
        chatIndex: nextChatIndex
      };
    }

    if (restoredPrompts) {
      const nextPromptIds = new Set(Object.keys(restoredPrompts.prompts));
      if (prevPrompts) {
        for (const prevId of Object.keys(prevPrompts.prompts)) {
          if (!nextPromptIds.has(prevId)) {
            meta.tombstones.prompts[prevId] = stamp;
          }
        }
      }
      for (const id of nextPromptIds) {
        delete meta.tombstones.prompts[id];
      }

      const nextPrompts: PromptsData['prompts'] = {};
      for (const [id, prompt] of Object.entries(restoredPrompts.prompts)) {
        nextPrompts[id] = { ...prompt, updatedAt: stamp };
      }
      stampedPrompts = { version: 1, prompts: nextPrompts };
    }

    meta.tombstones = pruneAndBoundTombstones(meta.tombstones, stamp);
    await this.persistMeta(meta);
    return { projects: stampedProjects, prompts: stampedPrompts, stamp };
  }

  public cancelDebouncedPush(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  public scheduleDebouncedPush(): void {
    if (!this.available) return;
    if (this.localMeta && !this.localMeta.enabled) return;
    this.cancelDebouncedPush();
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.hooks.runSerialized(async () => {
        await this.pushCurrentState();
      });
    }, this.debounceMs);
  }

  public async pushCurrentState(): Promise<SyncActionResult> {
    this.cancelDebouncedPush();
    const meta = await this.ensureMetaLoaded();
    if (!this.available) {
      return { ok: false, error: 'Chrome Sync is unavailable.', status: { ...meta.status } };
    }
    if (!meta.enabled) {
      return { ok: true, status: { ...meta.status } };
    }

    try {
      const rawRemote = await this.sync!.get(null);
      const parsed = parseRemoteSyncData(rawRemote);
      const localData = await this.hooks.readRawLocalSnapshot();
      const now = this.clockNow();

      let stateToPush = localData.state;
      let promptsToPush: PromptsData | null = localData.hasLocalPrompts ? localData.prompts : null;
      let remoteRev = meta.lastSyncedRev;

      // 若远端已有尚未合并的更新（例如并发双端修改且 onChanged 尚未抵达），先合并再推送避免覆盖。
      if (parsed.kind === 'valid') {
        remoteRev = Math.max(remoteRev, parsed.meta.rev);
        const isEcho =
          parsed.meta.clientId === meta.clientId &&
          parsed.meta.rev === meta.lastSyncedRev &&
          parsed.meta.hash === meta.lastSyncedHash;
        if (!isEcho && parsed.meta.hash !== meta.lastSyncedHash) {
          const merged = mergeSyncData(
            localData.state,
            localData.prompts,
            meta.tombstones,
            parsed.snapshot,
            now
          );
          const writeState = merged.stateChanged ||
            (!localData.hasLocalProjects && (merged.state.projects.length > 0 || Object.keys(merged.state.chatIndex).length > 0));
          const writePrompts = merged.promptsChanged || !localData.hasLocalPrompts;
          if (writeState || writePrompts) {
            await this.hooks.applyPulledData({
              state: writeState ? merged.state : undefined,
              prompts: writePrompts ? merged.prompts : undefined
            });
          }
          meta.tombstones = merged.tombstones;
          stateToPush = merged.state;
          promptsToPush = merged.prompts;
        }
      }

      const snapshot = extractSyncSnapshot(stateToPush, promptsToPush, meta.tombstones, now);
      const nextRev = Math.max(meta.lastSyncedRev, remoteRev) + 1;
      const packed = packSyncPayload(snapshot, {
        clientId: meta.clientId,
        rev: nextRev,
        updatedAt: now
      });

      if (parsed.kind === 'valid' && parsed.meta.hash === packed.hash) {
        meta.lastSyncedRev = parsed.meta.rev;
        meta.lastSyncedHash = parsed.meta.hash;
        meta.lastSyncedAt = now;
        meta.tombstones = snapshot.tombstones;
        meta.status = buildStatusFromPack(meta, true, packed, now);
        await this.persistMeta(meta);
        return { ok: true, status: { ...meta.status } };
      }

      await this.writePackedWithCleanup(packed, rawRemote);

      meta.lastSyncedRev = nextRev;
      meta.lastSyncedHash = packed.hash;
      meta.lastSyncedAt = now;
      meta.tombstones = snapshot.tombstones;
      meta.status = buildStatusFromPack(meta, true, packed, now);
      await this.persistMeta(meta);
      return { ok: true, status: { ...meta.status } };
    } catch (error) {
      const classified = classifyError(error);
      meta.status = {
        ...meta.status,
        enabled: meta.enabled,
        available: this.available,
        state: classified.state,
        lastError: classified.message
      };
      await this.persistMeta(meta);
      return { ok: false, error: classified.message, status: { ...meta.status } };
    }
  }

  public async handleSyncChanged(changes: Record<string, chrome.storage.StorageChange>): Promise<void> {
    const hasSyncKey = Object.keys(changes).some((key) => key.startsWith(SYNC_PREFIX));
    if (!hasSyncKey) return;

    const meta = await this.ensureMetaLoaded();
    if (!this.available || !meta.enabled) return;

    try {
      const rawMeta = Object.hasOwn(changes, SYNC_META_KEY)
        ? changes[SYNC_META_KEY]?.newValue
        : (await this.sync!.get(SYNC_META_KEY))[SYNC_META_KEY];
      const remoteMeta = sanitizeSyncMeta(rawMeta);
      if (
        remoteMeta &&
        remoteMeta.clientId === meta.clientId &&
        remoteMeta.rev === meta.lastSyncedRev &&
        remoteMeta.hash === meta.lastSyncedHash
      ) {
        // 持久化回声抑制：本端刚写入的 rev + hash 变更直接忽略。
        return;
      }
    } catch {
      // 回退到完整对账。
    }

    await this.reconcileWithRemote('pull');
  }

  public async setEnabled(enabled: boolean): Promise<SyncActionResult> {
    this.cancelDebouncedPush();
    const meta = await this.ensureMetaLoaded();
    meta.enabled = enabled;

    if (!this.available) {
      meta.status = {
        ...meta.status,
        enabled,
        available: false,
        state: 'unavailable',
        lastError: undefined
      };
      await this.persistMeta(meta);
      return { ok: true, status: { ...meta.status } };
    }

    if (!enabled) {
      meta.status = {
        ...meta.status,
        enabled: false,
        available: true,
        state: 'disabled',
        lastError: undefined
      };
      await this.persistMeta(meta);
      return { ok: true, status: { ...meta.status } };
    }

    return this.reconcileWithRemote('enable');
  }

  public async syncNow(): Promise<SyncActionResult> {
    this.cancelDebouncedPush();
    const meta = await this.ensureMetaLoaded();
    if (!this.available) {
      return { ok: false, error: 'Chrome Sync is unavailable.', status: { ...meta.status } };
    }
    if (!meta.enabled) {
      return { ok: false, error: 'Chrome Sync is turned off.', status: { ...meta.status } };
    }
    return this.reconcileWithRemote('manual');
  }

  private async reconcileWithRemote(mode: 'init' | 'pull' | 'manual' | 'enable'): Promise<SyncActionResult> {
    const meta = await this.ensureMetaLoaded();
    if (!this.available || !meta.enabled) {
      return { ok: false, error: 'Chrome Sync is not active.', status: { ...meta.status } };
    }

    if (mode === 'manual' || mode === 'enable') {
      meta.status = {
        ...meta.status,
        enabled: true,
        available: true,
        state: 'syncing',
        lastError: undefined
      };
      await this.persistMeta(meta);
    }

    try {
      const rawRemote = await this.sync!.get(null);
      const parsed = parseRemoteSyncData(rawRemote);
      const localData = await this.hooks.readRawLocalSnapshot();
      const now = this.clockNow();

      if (parsed.kind === 'invalid') {
        meta.status = {
          ...meta.status,
          enabled: true,
          available: true,
          state: 'error',
          lastError: parsed.reason
        };
        await this.persistMeta(meta);
        return { ok: false, error: parsed.reason, status: { ...meta.status } };
      }

      if (parsed.kind === 'empty') {
        if (mode === 'init' && !localData.hasLocalProjects && !localData.hasLocalPrompts) {
          // 双方均未初始化：等待本地首次创建或种子提示词后再推送，避免提前写入空元信息。
          if (meta.status.state !== 'idle') {
            meta.status = {
              ...meta.status,
              enabled: true,
              available: true,
              state: 'idle',
              lastError: undefined
            };
            await this.persistMeta(meta);
          }
          return { ok: true, status: { ...meta.status } };
        }

        const snapshot = extractSyncSnapshot(
          localData.state,
          localData.hasLocalPrompts ? localData.prompts : null,
          meta.tombstones,
          now
        );
        const nextRev = meta.lastSyncedRev + 1;
        const packed = packSyncPayload(snapshot, {
          clientId: meta.clientId,
          rev: nextRev,
          updatedAt: now
        });
        await this.writePackedWithCleanup(packed, rawRemote);

        meta.lastSyncedRev = nextRev;
        meta.lastSyncedHash = packed.hash;
        meta.lastSyncedAt = now;
        meta.tombstones = snapshot.tombstones;
        meta.status = buildStatusFromPack(meta, true, packed, now);
        await this.persistMeta(meta);
        return { ok: true, status: { ...meta.status } };
      }

      // parsed.kind === 'valid'
      const remoteMeta = parsed.meta;
      const merged = mergeSyncData(
        localData.state,
        localData.prompts,
        meta.tombstones,
        parsed.snapshot,
        now
      );

      const writeState =
        merged.stateChanged ||
        (!localData.hasLocalProjects &&
          (merged.state.projects.length > 0 || Object.keys(merged.state.chatIndex).length > 0));
      // 冷启动时远端已有数据，必须落盘 PROMPTS_KEY（即使远端为空）以阻止 createSeedData() 生成重复默认提示词。
      const writePrompts = merged.promptsChanged || !localData.hasLocalPrompts;

      if (writeState || writePrompts) {
        await this.hooks.applyPulledData({
          state: writeState ? merged.state : undefined,
          prompts: writePrompts ? merged.prompts : undefined
        });
      }

      const mergedSnapshot = extractSyncSnapshot(merged.state, merged.prompts, merged.tombstones, now);
      const nextRev = Math.max(meta.lastSyncedRev, remoteMeta.rev) + 1;
      const packed = packSyncPayload(mergedSnapshot, {
        clientId: meta.clientId,
        rev: nextRev,
        updatedAt: now
      });

      if (packed.hash === remoteMeta.hash) {
        meta.lastSyncedRev = remoteMeta.rev;
        meta.lastSyncedHash = remoteMeta.hash;
        meta.lastSyncedAt = now;
        meta.tombstones = mergedSnapshot.tombstones;
        meta.status = buildStatusFromPack(meta, true, packed, now);
        await this.persistMeta(meta);
        return { ok: true, status: { ...meta.status } };
      }

      await this.writePackedWithCleanup(packed, rawRemote);
      meta.lastSyncedRev = nextRev;
      meta.lastSyncedHash = packed.hash;
      meta.lastSyncedAt = now;
      meta.tombstones = mergedSnapshot.tombstones;
      meta.status = buildStatusFromPack(meta, true, packed, now);
      await this.persistMeta(meta);
      return { ok: true, status: { ...meta.status } };
    } catch (error) {
      const classified = classifyError(error);
      meta.status = {
        ...meta.status,
        enabled: meta.enabled,
        available: this.available,
        state: classified.state,
        lastError: classified.message
      };
      await this.persistMeta(meta);
      return { ok: false, error: classified.message, status: { ...meta.status } };
    }
  }

  private async writePackedWithCleanup(
    packed: PackedSyncPayload,
    rawRemoteBefore: Record<string, unknown>
  ): Promise<void> {
    const newKeys = new Set(Object.keys(packed.items));
    const staleKeys = Object.keys(rawRemoteBefore).filter(
      (key) => key.startsWith(SYNC_PREFIX) && !newKeys.has(key)
    );

    try {
      await this.sync!.set(packed.items);
      if (staleKeys.length > 0) {
        await this.sync!.remove(staleKeys);
      }
    } catch (error) {
      // 配额不足且存在旧分片键时，先清理旧分片键再重试写入一次。
      if (isQuotaError(error) && staleKeys.length > 0) {
        await this.sync!.remove(staleKeys);
        await this.sync!.set(packed.items);
        return;
      }
      throw error;
    }
  }

  public dispose(): void {
    this.cancelDebouncedPush();
  }
}
