import { PromptsData } from '../shared/prompts';
import { StoredState } from '../shared/types';
import {
  CloudSyncState,
  CloudSyncStatus,
  computeSnapshotHash,
  createDefaultLocalMeta,
  DRIVE_TOMBSTONES_BYTE_LIMIT,
  DriveSyncEnvelopeV1,
  extractSyncSnapshot,
  mergeSyncData,
  PackedSyncPayload,
  packSyncPayload,
  parseDriveSyncEnvelope,
  parseRemoteSyncData,
  pruneAndBoundTombstones,
  sanitizeLocalMeta,
  sanitizeSyncMeta,
  SYNC_LOCAL_META_KEY,
  SYNC_META_KEY,
  SYNC_PREFIX,
  SYNC_STALE_INTERVAL_MS,
  SYNC_TOMBSTONES_BYTE_LIMIT,
  SYNC_TOTAL_BYTE_LIMIT,
  SyncLocalMeta,
  utf8ByteLength
} from '../shared/sync';
import {
  DRIVE_SESSION_EXPIRED_MESSAGE,
  DriveAuthError,
  DriveFileMeta,
  GoogleDriveSyncClient
} from './googleDriveSync';

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
  drive?: GoogleDriveSyncClient | null;
  hooks: CloudSyncStoreHooks;
  now?: () => number;
  randomUUID?: () => string;
  debounceMs?: number;
  staleIntervalMs?: number;
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

function classifyBrowserSyncError(error: unknown): { state: 'quota_exceeded' | 'error'; message: string } {
  if (isRateLimitError(error)) {
    return {
      state: 'error',
      message: 'Browser Sync rate limit reached. Will sync on next change.'
    };
  }
  if (isQuotaError(error)) {
    return {
      state: 'quota_exceeded',
      message: 'Browser Sync storage is full. Your data is still saved locally.'
    };
  }
  return {
    state: 'error',
    message: error instanceof Error && error.message ? error.message : 'Browser Sync failed.'
  };
}

function classifyDriveError(error: unknown): { state: 'auth_expired' | 'error'; message: string } {
  if (error instanceof DriveAuthError && error.code === 'auth_expired') {
    return {
      state: 'auth_expired',
      message: DRIVE_SESSION_EXPIRED_MESSAGE
    };
  }
  return {
    state: 'error',
    message: error instanceof Error && error.message ? error.message : 'Google Drive sync failed.'
  };
}

export class CloudSyncManager {
  private readonly local: StorageAreaLike;
  private readonly sync: StorageAreaLike | null;
  private readonly drive: GoogleDriveSyncClient | null;
  private readonly hooks: CloudSyncStoreHooks;
  private readonly clockNow: () => number;
  private readonly generateId: () => string;
  private readonly debounceMs: number;
  private readonly staleIntervalMs: number;

  private localMeta: SyncLocalMeta | null = null;
  private initialized = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastDriveAttemptAt = 0;

  constructor(options: CloudSyncOptions) {
    this.local = options.local;
    this.sync = options.sync;
    this.drive = options.drive ?? null;
    this.hooks = options.hooks;
    this.clockNow = options.now ?? (() => Date.now());
    this.generateId = options.randomUUID ?? (() => crypto.randomUUID());
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.staleIntervalMs = options.staleIntervalMs ?? SYNC_STALE_INTERVAL_MS;
  }

  private get available(): boolean {
    return this.sync !== null;
  }

  private get driveAvailable(): boolean {
    return this.drive !== null && this.drive.available;
  }

  private getTombstoneLimit(meta: SyncLocalMeta): number {
    return meta.provider === 'google_drive' ? DRIVE_TOMBSTONES_BYTE_LIMIT : SYNC_TOMBSTONES_BYTE_LIMIT;
  }

  private buildBrowserStatus(
    meta: SyncLocalMeta,
    state: CloudSyncState,
    extra: Partial<Pick<CloudSyncStatus, 'lastSyncedAt' | 'lastError' | 'omittedChats' | 'omittedPrompts' | 'bytesUsed'>> = {}
  ): CloudSyncStatus {
    const status: CloudSyncStatus = {
      provider: 'browser',
      enabled: meta.enabled,
      available: this.available,
      driveAvailable: this.driveAvailable,
      state,
      lastSyncedAt: extra.lastSyncedAt !== undefined ? extra.lastSyncedAt : meta.lastSyncedAt,
      bytesLimit: SYNC_TOTAL_BYTE_LIMIT
    };
    if (extra.lastError) status.lastError = extra.lastError;
    if (extra.omittedChats && extra.omittedChats > 0) status.omittedChats = extra.omittedChats;
    if (extra.omittedPrompts && extra.omittedPrompts > 0) status.omittedPrompts = extra.omittedPrompts;
    if (extra.bytesUsed !== undefined) status.bytesUsed = extra.bytesUsed;
    return status;
  }

  private buildStatusFromPack(
    meta: SyncLocalMeta,
    packed: PackedSyncPayload,
    syncedAt: number
  ): CloudSyncStatus {
    const isPartial = packed.omittedProjects > 0 || packed.omittedChats > 0 || packed.omittedPrompts > 0;
    return this.buildBrowserStatus(meta, isPartial ? 'partial' : 'synced', {
      lastSyncedAt: syncedAt,
      bytesUsed: packed.bytesUsed,
      omittedChats: packed.omittedChats > 0 ? packed.omittedChats : undefined,
      omittedPrompts: packed.omittedPrompts > 0 ? packed.omittedPrompts : undefined
    });
  }

  private buildDriveStatus(
    meta: SyncLocalMeta,
    state: CloudSyncState,
    extra: Partial<Pick<CloudSyncStatus, 'lastSyncedAt' | 'lastError' | 'bytesUsed'>> = {}
  ): CloudSyncStatus {
    const status: CloudSyncStatus = {
      provider: 'google_drive',
      enabled: meta.enabled,
      available: this.available,
      driveAvailable: this.driveAvailable,
      state,
      lastSyncedAt: extra.lastSyncedAt !== undefined ? extra.lastSyncedAt : (meta.driveLastSyncedAt ?? null),
      bytesLimit: 0
    };
    if (extra.lastError) status.lastError = extra.lastError;
    if (extra.bytesUsed !== undefined) status.bytesUsed = extra.bytesUsed;
    return status;
  }

  private async ensureMetaLoaded(): Promise<SyncLocalMeta> {
    if (this.localMeta) return this.localMeta;
    const raw = (await this.local.get(SYNC_LOCAL_META_KEY))[SYNC_LOCAL_META_KEY];
    if (raw === undefined) {
      const fresh = createDefaultLocalMeta(this.generateId(), this.available, true, this.driveAvailable);
      await this.local.set({ [SYNC_LOCAL_META_KEY]: fresh });
      this.localMeta = fresh;
      return fresh;
    }
    const normalized = sanitizeLocalMeta(raw, this.generateId(), this.available, this.driveAvailable);
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

    if (meta.provider === 'google_drive') {
      if (!this.driveAvailable) {
        if (meta.status.state !== 'unavailable' || meta.status.driveAvailable) {
          meta.status = this.buildDriveStatus(meta, 'unavailable');
          await this.persistMeta(meta);
        }
        return;
      }
      await this.reconcileWithDrive('init');
      return;
    }

    if (!this.available) {
      if (meta.status.state !== 'unavailable' || meta.status.available || meta.status.driveAvailable !== this.driveAvailable) {
        meta.status = this.buildBrowserStatus(meta, 'unavailable');
        await this.persistMeta(meta);
      }
      return;
    }

    if (!meta.enabled) {
      if (meta.status.state !== 'disabled' || meta.status.enabled || meta.status.driveAvailable !== this.driveAvailable) {
        meta.status = this.buildBrowserStatus(meta, 'disabled');
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
    meta.tombstones = pruneAndBoundTombstones(meta.tombstones, ts, this.getTombstoneLimit(meta));
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
    meta.tombstones = pruneAndBoundTombstones(meta.tombstones, ts, this.getTombstoneLimit(meta));
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
    meta.tombstones = pruneAndBoundTombstones(meta.tombstones, ts, this.getTombstoneLimit(meta));
    await this.persistMeta(meta);
  }

  public async prepareBackupRestore(
    prevState: StoredState,
    prevPrompts: PromptsData | null,
    restoredProjects: StoredState | undefined,
    restoredPrompts: PromptsData | undefined
  ): Promise<{ projects?: StoredState; prompts?: PromptsData; stamp: number }> {
    const meta = await this.ensureMetaLoaded();

    let maxTs = Math.max(meta.lastSyncedAt ?? 0, meta.driveLastSyncedAt ?? 0);
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

    meta.tombstones = pruneAndBoundTombstones(meta.tombstones, stamp, this.getTombstoneLimit(meta));
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
    if (this.localMeta) {
      if (this.localMeta.provider === 'google_drive') {
        if (!this.driveAvailable) return;
      } else {
        if (!this.available || !this.localMeta.enabled) return;
      }
    } else if (!this.available && !this.driveAvailable) {
      return;
    }
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

    if (meta.provider === 'google_drive') {
      if (!this.driveAvailable) {
        return { ok: false, error: 'Google Drive sync is unavailable.', status: { ...meta.status } };
      }
      return this.reconcileWithDrive('push');
    }

    if (!this.available) {
      return { ok: false, error: 'Browser Sync is unavailable.', status: { ...meta.status } };
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
        meta.status = this.buildStatusFromPack(meta, packed, now);
        await this.persistMeta(meta);
        return { ok: true, status: { ...meta.status } };
      }

      await this.writePackedWithCleanup(packed, rawRemote);

      meta.lastSyncedRev = nextRev;
      meta.lastSyncedHash = packed.hash;
      meta.lastSyncedAt = now;
      meta.tombstones = snapshot.tombstones;
      meta.status = this.buildStatusFromPack(meta, packed, now);
      await this.persistMeta(meta);
      return { ok: true, status: { ...meta.status } };
    } catch (error) {
      const classified = classifyBrowserSyncError(error);
      meta.status = this.buildBrowserStatus(meta, classified.state, {
        lastError: classified.message,
        bytesUsed: meta.status.bytesUsed
      });
      await this.persistMeta(meta);
      return { ok: false, error: classified.message, status: { ...meta.status } };
    }
  }

  public async handleSyncChanged(changes: Record<string, chrome.storage.StorageChange>): Promise<void> {
    const hasSyncKey = Object.keys(changes).some((key) => key.startsWith(SYNC_PREFIX));
    if (!hasSyncKey) return;

    const meta = await this.ensureMetaLoaded();
    // 互斥原则：启用 Google Drive 时忽略 chrome.storage.sync 变更，避免双端互相覆盖。
    if (meta.provider !== 'browser' || !this.available || !meta.enabled) return;

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

    if (meta.provider === 'google_drive') {
      meta.status = { ...meta.status, enabled };
      await this.persistMeta(meta);
      return { ok: true, status: { ...meta.status } };
    }

    if (!this.available) {
      meta.status = this.buildBrowserStatus(meta, 'unavailable');
      await this.persistMeta(meta);
      return { ok: true, status: { ...meta.status } };
    }

    if (!enabled) {
      meta.status = this.buildBrowserStatus(meta, 'disabled');
      await this.persistMeta(meta);
      return { ok: true, status: { ...meta.status } };
    }

    return this.reconcileWithRemote('enable');
  }

  public async syncNow(): Promise<SyncActionResult> {
    this.cancelDebouncedPush();
    const meta = await this.ensureMetaLoaded();

    if (meta.provider === 'google_drive') {
      if (!this.driveAvailable) {
        return { ok: false, error: 'Google Drive sync is unavailable.', status: { ...meta.status } };
      }
      return this.reconcileWithDrive('manual');
    }

    if (!this.available) {
      return { ok: false, error: 'Browser Sync is unavailable.', status: { ...meta.status } };
    }
    if (!meta.enabled) {
      return { ok: false, error: 'Browser Sync is turned off.', status: { ...meta.status } };
    }
    return this.reconcileWithRemote('manual');
  }

  public async syncIfStale(): Promise<SyncActionResult> {
    const meta = await this.ensureMetaLoaded();
    if (meta.provider !== 'google_drive') {
      return { ok: true, status: { ...meta.status } };
    }
    if (!this.driveAvailable) {
      return { ok: false, error: 'Google Drive sync is unavailable.', status: { ...meta.status } };
    }
    // 授权过期时等待用户主动重连，不在切回标签页时反复触发静默鉴权。
    if (meta.status.state === 'auth_expired') {
      return { ok: true, status: { ...meta.status } };
    }
    const now = this.clockNow();
    const lastCheck = Math.max(this.lastDriveAttemptAt, meta.driveLastSyncedAt ?? 0);
    if (lastCheck > 0 && now - lastCheck < this.staleIntervalMs) {
      return { ok: true, status: { ...meta.status } };
    }
    return this.reconcileWithDrive('stale');
  }

  public async connectGoogleDrive(): Promise<SyncActionResult> {
    this.cancelDebouncedPush();
    const meta = await this.ensureMetaLoaded();
    this.initialized = true;

    if (!this.driveAvailable) {
      return {
        ok: false,
        error: 'Google Drive sync is unavailable in this browser.',
        status: { ...meta.status }
      };
    }

    try {
      // 先完成用户交互授权再切换 provider，取消或失败时保持当前同步方式不变。
      await this.drive!.authenticate(true);
    } catch (error) {
      const message = error instanceof Error && error.message
        ? error.message
        : 'Google Drive sign-in failed.';
      return { ok: false, error: message, status: { ...meta.status } };
    }

    meta.provider = 'google_drive';
    meta.status = this.buildDriveStatus(meta, 'syncing', {
      bytesUsed: meta.status.provider === 'google_drive' ? meta.status.bytesUsed : undefined
    });
    await this.persistMeta(meta);

    return this.reconcileWithDrive('connect');
  }

  public async disconnectGoogleDrive(): Promise<SyncActionResult> {
    this.cancelDebouncedPush();
    const meta = await this.ensureMetaLoaded();
    this.initialized = true;

    await this.drive?.clearToken();
    meta.provider = 'browser';

    if (!this.available) {
      meta.status = this.buildBrowserStatus(meta, 'unavailable');
      await this.persistMeta(meta);
      return { ok: true, status: { ...meta.status } };
    }

    if (!meta.enabled) {
      meta.status = this.buildBrowserStatus(meta, 'disabled');
      await this.persistMeta(meta);
      return { ok: true, status: { ...meta.status } };
    }

    meta.status = this.buildBrowserStatus(meta, 'idle');
    await this.persistMeta(meta);
    const browserResult = await this.reconcileWithRemote('enable');
    return { ok: true, status: browserResult.status };
  }

  private async reconcileWithDrive(
    mode: 'init' | 'connect' | 'manual' | 'stale' | 'push'
  ): Promise<SyncActionResult> {
    const meta = await this.ensureMetaLoaded();
    if (meta.provider !== 'google_drive' || !this.driveAvailable) {
      return { ok: false, error: 'Google Drive sync is not active.', status: { ...meta.status } };
    }

    this.lastDriveAttemptAt = this.clockNow();

    if (mode === 'manual') {
      meta.status = this.buildDriveStatus(meta, 'syncing', { bytesUsed: meta.status.bytesUsed });
      await this.persistMeta(meta);
    }

    try {
      const localData = await this.hooks.readRawLocalSnapshot();
      const now = this.clockNow();

      // 写入快速路径：命中已缓存 driveFileId 时直接读取并对账，404 则回退完整列举。
      if (mode === 'push' && meta.driveFileId) {
        const fastResult = await this.tryFastDrivePush(meta, localData, now);
        if (fastResult !== null) return fastResult;
      }

      const files = await this.drive!.listSyncFiles();

      if (files.length === 0) {
        meta.driveFileId = undefined;
        meta.driveLastModifiedTime = undefined;

        if (mode === 'init' && !localData.hasLocalProjects && !localData.hasLocalPrompts) {
          if (meta.status.state !== 'idle') {
            meta.status = this.buildDriveStatus(meta, 'idle');
            await this.persistMeta(meta);
          }
          return { ok: true, status: { ...meta.status } };
        }

        const snapshot = extractSyncSnapshot(
          localData.state,
          localData.hasLocalPrompts ? localData.prompts : null,
          meta.tombstones,
          now,
          DRIVE_TOMBSTONES_BYTE_LIMIT
        );
        const hash = computeSnapshotHash(snapshot);
        const nextRev = (meta.driveLastSyncedRev ?? 0) + 1;
        const envelope: DriveSyncEnvelopeV1 = {
          v: 1,
          clientId: meta.clientId,
          rev: nextRev,
          updatedAt: now,
          hash,
          snapshot
        };
        const json = JSON.stringify(envelope);
        const created = await this.drive!.createSyncFile(json);

        meta.driveFileId = created.id;
        meta.driveLastModifiedTime = created.modifiedTime;
        meta.driveLastSyncedRev = nextRev;
        meta.driveLastSyncedHash = hash;
        meta.driveLastSyncedAt = now;
        meta.tombstones = snapshot.tombstones;
        meta.status = this.buildDriveStatus(meta, 'synced', {
          lastSyncedAt: now,
          bytesUsed: utf8ByteLength(json)
        });
        await this.persistMeta(meta);
        return { ok: true, status: { ...meta.status } };
      }

      // 焦点轻量检查：若单文件 modifiedTime 未变且本地快照哈希与上次一致，跳过下载。
      if (
        mode === 'stale' &&
        files.length === 1 &&
        files[0].id === meta.driveFileId &&
        files[0].modifiedTime &&
        files[0].modifiedTime === meta.driveLastModifiedTime &&
        meta.driveLastSyncedHash
      ) {
        const localSnapshot = extractSyncSnapshot(
          localData.state,
          localData.hasLocalPrompts ? localData.prompts : null,
          meta.tombstones,
          now,
          DRIVE_TOMBSTONES_BYTE_LIMIT
        );
        if (computeSnapshotHash(localSnapshot) === meta.driveLastSyncedHash) {
          if (meta.status.state !== 'synced') {
            meta.status = this.buildDriveStatus(meta, 'synced', {
              lastSyncedAt: meta.driveLastSyncedAt ?? now,
              bytesUsed: meta.status.bytesUsed
            });
            await this.persistMeta(meta);
          }
          return { ok: true, status: { ...meta.status } };
        }
      }

      if (files.length === 1) {
        return await this.reconcileSingleDriveFile(meta, files[0], localData, now);
      }

      // 并发冷启动产生多份同名同步文件时，合并全部有效副本到最旧主文件并清理多余副本。
      return await this.healDuplicateDriveFiles(meta, files, localData, now);
    } catch (error) {
      const classified = classifyDriveError(error);
      meta.status = this.buildDriveStatus(meta, classified.state, {
        lastError: classified.message,
        bytesUsed: meta.status.bytesUsed
      });
      await this.persistMeta(meta);
      return { ok: false, error: classified.message, status: { ...meta.status } };
    }
  }

  private async tryFastDrivePush(
    meta: SyncLocalMeta,
    localData: LocalDataSnapshot,
    now: number
  ): Promise<SyncActionResult | null> {
    const fileId = meta.driveFileId!;
    const readRes = await this.drive!.readSyncFile(fileId);
    if (readRes.kind === 'not_found') {
      meta.driveFileId = undefined;
      meta.driveLastModifiedTime = undefined;
      return null;
    }
    if (readRes.kind === 'corrupt') {
      meta.status = this.buildDriveStatus(meta, 'error', {
        lastError: readRes.reason,
        bytesUsed: meta.status.bytesUsed
      });
      await this.persistMeta(meta);
      return { ok: false, error: readRes.reason, status: { ...meta.status } };
    }

    const parsed = parseDriveSyncEnvelope(readRes.content);
    if (parsed.kind === 'invalid') {
      meta.status = this.buildDriveStatus(meta, 'error', {
        lastError: parsed.reason,
        bytesUsed: meta.status.bytesUsed
      });
      await this.persistMeta(meta);
      return { ok: false, error: parsed.reason, status: { ...meta.status } };
    }

    const remoteEnv = parsed.envelope;
    const isEcho =
      remoteEnv.clientId === meta.clientId &&
      remoteEnv.rev === (meta.driveLastSyncedRev ?? 0) &&
      remoteEnv.hash === (meta.driveLastSyncedHash ?? '');

    let stateToPush = localData.state;
    let promptsToPush: PromptsData | null = localData.hasLocalPrompts ? localData.prompts : null;
    let tombstonesToPush = meta.tombstones;

    if (!isEcho && remoteEnv.hash !== meta.driveLastSyncedHash) {
      const merged = mergeSyncData(
        localData.state,
        localData.prompts,
        meta.tombstones,
        remoteEnv.snapshot,
        now,
        DRIVE_TOMBSTONES_BYTE_LIMIT
      );
      const writeState =
        merged.stateChanged ||
        (!localData.hasLocalProjects &&
          (merged.state.projects.length > 0 || Object.keys(merged.state.chatIndex).length > 0));
      const writePrompts = merged.promptsChanged || !localData.hasLocalPrompts;
      if (writeState || writePrompts) {
        await this.hooks.applyPulledData({
          state: writeState ? merged.state : undefined,
          prompts: writePrompts ? merged.prompts : undefined
        });
      }
      stateToPush = merged.state;
      promptsToPush = merged.prompts;
      tombstonesToPush = merged.tombstones;
    }

    const snapshot = extractSyncSnapshot(
      stateToPush,
      promptsToPush,
      tombstonesToPush,
      now,
      DRIVE_TOMBSTONES_BYTE_LIMIT
    );
    const hash = computeSnapshotHash(snapshot);

    if (hash === remoteEnv.hash) {
      meta.driveLastSyncedRev = remoteEnv.rev;
      meta.driveLastSyncedHash = remoteEnv.hash;
      meta.driveLastSyncedAt = now;
      meta.tombstones = snapshot.tombstones;
      meta.status = this.buildDriveStatus(meta, 'synced', {
        lastSyncedAt: now,
        bytesUsed: readRes.rawBytes
      });
      await this.persistMeta(meta);
      return { ok: true, status: { ...meta.status } };
    }

    const nextRev = Math.max(meta.driveLastSyncedRev ?? 0, remoteEnv.rev) + 1;
    const nextEnvelope: DriveSyncEnvelopeV1 = {
      v: 1,
      clientId: meta.clientId,
      rev: nextRev,
      updatedAt: now,
      hash,
      snapshot
    };
    const json = JSON.stringify(nextEnvelope);
    const patchRes = await this.drive!.updateSyncFile(fileId, json);
    if (patchRes.notFound) {
      meta.driveFileId = undefined;
      meta.driveLastModifiedTime = undefined;
      return null;
    }

    meta.driveFileId = fileId;
    meta.driveLastModifiedTime = patchRes.modifiedTime;
    meta.driveLastSyncedRev = nextRev;
    meta.driveLastSyncedHash = hash;
    meta.driveLastSyncedAt = now;
    meta.tombstones = snapshot.tombstones;
    meta.status = this.buildDriveStatus(meta, 'synced', {
      lastSyncedAt: now,
      bytesUsed: utf8ByteLength(json)
    });
    await this.persistMeta(meta);
    return { ok: true, status: { ...meta.status } };
  }

  private async reconcileSingleDriveFile(
    meta: SyncLocalMeta,
    primary: DriveFileMeta,
    localData: LocalDataSnapshot,
    now: number
  ): Promise<SyncActionResult> {
    const readRes = await this.drive!.readSyncFile(primary.id);
    if (readRes.kind === 'not_found') {
      const snapshot = extractSyncSnapshot(
        localData.state,
        localData.hasLocalPrompts ? localData.prompts : null,
        meta.tombstones,
        now,
        DRIVE_TOMBSTONES_BYTE_LIMIT
      );
      const hash = computeSnapshotHash(snapshot);
      const nextRev = (meta.driveLastSyncedRev ?? 0) + 1;
      const envelope: DriveSyncEnvelopeV1 = {
        v: 1,
        clientId: meta.clientId,
        rev: nextRev,
        updatedAt: now,
        hash,
        snapshot
      };
      const json = JSON.stringify(envelope);
      const created = await this.drive!.createSyncFile(json);
      meta.driveFileId = created.id;
      meta.driveLastModifiedTime = created.modifiedTime;
      meta.driveLastSyncedRev = nextRev;
      meta.driveLastSyncedHash = hash;
      meta.driveLastSyncedAt = now;
      meta.tombstones = snapshot.tombstones;
      meta.status = this.buildDriveStatus(meta, 'synced', {
        lastSyncedAt: now,
        bytesUsed: utf8ByteLength(json)
      });
      await this.persistMeta(meta);
      return { ok: true, status: { ...meta.status } };
    }

    if (readRes.kind === 'corrupt') {
      meta.status = this.buildDriveStatus(meta, 'error', {
        lastError: readRes.reason,
        bytesUsed: meta.status.bytesUsed
      });
      await this.persistMeta(meta);
      return { ok: false, error: readRes.reason, status: { ...meta.status } };
    }

    const parsed = parseDriveSyncEnvelope(readRes.content);
    if (parsed.kind === 'invalid') {
      meta.status = this.buildDriveStatus(meta, 'error', {
        lastError: parsed.reason,
        bytesUsed: meta.status.bytesUsed
      });
      await this.persistMeta(meta);
      return { ok: false, error: parsed.reason, status: { ...meta.status } };
    }

    const remoteEnv = parsed.envelope;
    const merged = mergeSyncData(
      localData.state,
      localData.prompts,
      meta.tombstones,
      remoteEnv.snapshot,
      now,
      DRIVE_TOMBSTONES_BYTE_LIMIT
    );
    const writeState =
      merged.stateChanged ||
      (!localData.hasLocalProjects &&
        (merged.state.projects.length > 0 || Object.keys(merged.state.chatIndex).length > 0));
    // 冷启动连接 Google Drive 时远端已有数据，必须落盘 PROMPTS_KEY 阻止生成重复默认提示词。
    const writePrompts = merged.promptsChanged || !localData.hasLocalPrompts;

    if (writeState || writePrompts) {
      await this.hooks.applyPulledData({
        state: writeState ? merged.state : undefined,
        prompts: writePrompts ? merged.prompts : undefined
      });
    }

    const mergedSnapshot = extractSyncSnapshot(
      merged.state,
      merged.prompts,
      merged.tombstones,
      now,
      DRIVE_TOMBSTONES_BYTE_LIMIT
    );
    const hash = computeSnapshotHash(mergedSnapshot);

    if (hash === remoteEnv.hash) {
      meta.driveFileId = primary.id;
      meta.driveLastModifiedTime = primary.modifiedTime;
      meta.driveLastSyncedRev = remoteEnv.rev;
      meta.driveLastSyncedHash = remoteEnv.hash;
      meta.driveLastSyncedAt = now;
      meta.tombstones = mergedSnapshot.tombstones;
      meta.status = this.buildDriveStatus(meta, 'synced', {
        lastSyncedAt: now,
        bytesUsed: readRes.rawBytes
      });
      await this.persistMeta(meta);
      return { ok: true, status: { ...meta.status } };
    }

    const nextRev = Math.max(meta.driveLastSyncedRev ?? 0, remoteEnv.rev) + 1;
    const nextEnvelope: DriveSyncEnvelopeV1 = {
      v: 1,
      clientId: meta.clientId,
      rev: nextRev,
      updatedAt: now,
      hash,
      snapshot: mergedSnapshot
    };
    const json = JSON.stringify(nextEnvelope);
    const patchRes = await this.drive!.updateSyncFile(primary.id, json);

    let finalFileId = primary.id;
    let finalModifiedTime = patchRes.notFound ? undefined : patchRes.modifiedTime;
    if (patchRes.notFound) {
      const created = await this.drive!.createSyncFile(json);
      finalFileId = created.id;
      finalModifiedTime = created.modifiedTime;
    }

    meta.driveFileId = finalFileId;
    meta.driveLastModifiedTime = finalModifiedTime;
    meta.driveLastSyncedRev = nextRev;
    meta.driveLastSyncedHash = hash;
    meta.driveLastSyncedAt = now;
    meta.tombstones = mergedSnapshot.tombstones;
    meta.status = this.buildDriveStatus(meta, 'synced', {
      lastSyncedAt: now,
      bytesUsed: utf8ByteLength(json)
    });
    await this.persistMeta(meta);
    return { ok: true, status: { ...meta.status } };
  }

  private async healDuplicateDriveFiles(
    meta: SyncLocalMeta,
    files: DriveFileMeta[],
    localData: LocalDataSnapshot,
    now: number
  ): Promise<SyncActionResult> {
    const primary = files[0];
    const duplicates = files.slice(1);
    const readResults = await Promise.all(files.map((file) => this.drive!.readSyncFile(file.id)));

    const validEnvelopes: DriveSyncEnvelopeV1[] = [];
    for (const readRes of readResults) {
      if (readRes.kind !== 'found') continue;
      const parsed = parseDriveSyncEnvelope(readRes.content);
      if (parsed.kind === 'valid') {
        validEnvelopes.push(parsed.envelope);
      }
    }

    if (validEnvelopes.length === 0) {
      const reason = 'Google Drive sync files are corrupted.';
      meta.status = this.buildDriveStatus(meta, 'error', {
        lastError: reason,
        bytesUsed: meta.status.bytesUsed
      });
      await this.persistMeta(meta);
      return { ok: false, error: reason, status: { ...meta.status } };
    }

    let currentState = localData.state;
    let currentPrompts = localData.prompts;
    let currentTombstones = meta.tombstones;
    let maxRemoteRev = meta.driveLastSyncedRev ?? 0;
    let anyStateChanged = false;
    let anyPromptsChanged = false;

    for (const envelope of validEnvelopes) {
      maxRemoteRev = Math.max(maxRemoteRev, envelope.rev);
      const merged = mergeSyncData(
        currentState,
        currentPrompts,
        currentTombstones,
        envelope.snapshot,
        now,
        DRIVE_TOMBSTONES_BYTE_LIMIT
      );
      currentState = merged.state;
      currentPrompts = merged.prompts;
      currentTombstones = merged.tombstones;
      if (merged.stateChanged) anyStateChanged = true;
      if (merged.promptsChanged) anyPromptsChanged = true;
    }

    const writeState =
      anyStateChanged ||
      (!localData.hasLocalProjects &&
        (currentState.projects.length > 0 || Object.keys(currentState.chatIndex).length > 0));
    const writePrompts = anyPromptsChanged || !localData.hasLocalPrompts;

    if (writeState || writePrompts) {
      await this.hooks.applyPulledData({
        state: writeState ? currentState : undefined,
        prompts: writePrompts ? currentPrompts : undefined
      });
    }

    const mergedSnapshot = extractSyncSnapshot(
      currentState,
      currentPrompts,
      currentTombstones,
      now,
      DRIVE_TOMBSTONES_BYTE_LIMIT
    );
    const hash = computeSnapshotHash(mergedSnapshot);
    const nextRev = Math.max(meta.driveLastSyncedRev ?? 0, maxRemoteRev) + 1;
    const nextEnvelope: DriveSyncEnvelopeV1 = {
      v: 1,
      clientId: meta.clientId,
      rev: nextRev,
      updatedAt: now,
      hash,
      snapshot: mergedSnapshot
    };
    const json = JSON.stringify(nextEnvelope);

    const patchRes = await this.drive!.updateSyncFile(primary.id, json);
    let finalFileId = primary.id;
    let finalModifiedTime = patchRes.notFound ? undefined : patchRes.modifiedTime;
    if (patchRes.notFound) {
      const created = await this.drive!.createSyncFile(json);
      finalFileId = created.id;
      finalModifiedTime = created.modifiedTime;
    }

    for (const duplicate of duplicates) {
      try {
        await this.drive!.deleteFile(duplicate.id);
      } catch {
        // 清理多余副本失败不影响已写回主文件的合并结果。
      }
    }

    meta.driveFileId = finalFileId;
    meta.driveLastModifiedTime = finalModifiedTime;
    meta.driveLastSyncedRev = nextRev;
    meta.driveLastSyncedHash = hash;
    meta.driveLastSyncedAt = now;
    meta.tombstones = mergedSnapshot.tombstones;
    meta.status = this.buildDriveStatus(meta, 'synced', {
      lastSyncedAt: now,
      bytesUsed: utf8ByteLength(json)
    });
    await this.persistMeta(meta);
    return { ok: true, status: { ...meta.status } };
  }

  private async reconcileWithRemote(mode: 'init' | 'pull' | 'manual' | 'enable'): Promise<SyncActionResult> {
    const meta = await this.ensureMetaLoaded();
    if (meta.provider !== 'browser' || !this.available || !meta.enabled) {
      return { ok: false, error: 'Browser Sync is not active.', status: { ...meta.status } };
    }

    if (mode === 'manual' || mode === 'enable') {
      meta.status = this.buildBrowserStatus(meta, 'syncing', { bytesUsed: meta.status.bytesUsed });
      await this.persistMeta(meta);
    }

    try {
      const rawRemote = await this.sync!.get(null);
      const parsed = parseRemoteSyncData(rawRemote);
      const localData = await this.hooks.readRawLocalSnapshot();
      const now = this.clockNow();

      if (parsed.kind === 'invalid') {
        meta.status = this.buildBrowserStatus(meta, 'error', {
          lastError: parsed.reason,
          bytesUsed: meta.status.bytesUsed
        });
        await this.persistMeta(meta);
        return { ok: false, error: parsed.reason, status: { ...meta.status } };
      }

      if (parsed.kind === 'empty') {
        if (mode === 'init' && !localData.hasLocalProjects && !localData.hasLocalPrompts) {
          // 双方均未初始化：等待本地首次创建或种子提示词后再推送，避免提前写入空元信息。
          if (meta.status.state !== 'idle') {
            meta.status = this.buildBrowserStatus(meta, 'idle');
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
        meta.status = this.buildStatusFromPack(meta, packed, now);
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
        meta.status = this.buildStatusFromPack(meta, packed, now);
        await this.persistMeta(meta);
        return { ok: true, status: { ...meta.status } };
      }

      await this.writePackedWithCleanup(packed, rawRemote);
      meta.lastSyncedRev = nextRev;
      meta.lastSyncedHash = packed.hash;
      meta.lastSyncedAt = now;
      meta.tombstones = mergedSnapshot.tombstones;
      meta.status = this.buildStatusFromPack(meta, packed, now);
      await this.persistMeta(meta);
      return { ok: true, status: { ...meta.status } };
    } catch (error) {
      const classified = classifyBrowserSyncError(error);
      meta.status = this.buildBrowserStatus(meta, classified.state, {
        lastError: classified.message,
        bytesUsed: meta.status.bytesUsed
      });
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
