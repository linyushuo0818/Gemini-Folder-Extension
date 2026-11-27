import { PromptsData } from '../shared/prompts';
import { StoredState } from '../shared/types';
import {
  CloudSyncState,
  CloudSyncStatus,
  computeSnapshotHash,
  createDefaultLocalMeta,
  createEmptyTombstones,
  DRIVE_TOMBSTONES_BYTE_LIMIT,
  DriveSyncEnvelopeV1,
  extractSyncSnapshot,
  mergeSyncData,
  parseDriveSyncEnvelope,
  pruneAndBoundTombstones,
  sanitizeLocalMeta,
  SYNC_LOCAL_META_KEY,
  SYNC_STALE_INTERVAL_MS,
  SyncChat,
  SyncLocalMeta,
  SyncProject,
  SyncPrompt,
  SyncSnapshot,
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
  private consecutiveErrorCount = 0;
  private disposed = false;

  constructor(options: CloudSyncOptions) {
    this.local = options.local;
    this.drive = options.drive ?? null;
    this.hooks = options.hooks;
    this.clockNow = options.now ?? (() => Date.now());
    this.generateId = options.randomUUID ?? (() => crypto.randomUUID());
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.staleIntervalMs = options.staleIntervalMs ?? SYNC_STALE_INTERVAL_MS;
  }

  private get available(): boolean {
    return this.drive !== null && this.drive.available;
  }

  private buildStatus(
    meta: SyncLocalMeta,
    state: CloudSyncState,
    extra: Partial<Pick<CloudSyncStatus, 'lastSyncedAt' | 'lastError' | 'bytesUsed'>> = {}
  ): CloudSyncStatus {
    const status: CloudSyncStatus = {
      enabled: meta.enabled,
      available: this.available,
      state,
      lastSyncedAt: extra.lastSyncedAt !== undefined ? extra.lastSyncedAt : meta.lastSyncedAt
    };
    if (extra.lastError) status.lastError = extra.lastError;
    if (extra.bytesUsed !== undefined) status.bytesUsed = extra.bytesUsed;
    return status;
  }

  private async ensureMetaLoaded(): Promise<SyncLocalMeta> {
    if (this.localMeta) return this.localMeta;
    const raw = (await this.local.get(SYNC_LOCAL_META_KEY))[SYNC_LOCAL_META_KEY];
    if (raw === undefined) {
      const fresh = createDefaultLocalMeta(this.generateId(), this.available, false);
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

  public isInitialized(): boolean {
    return this.initialized;
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
        meta.status = this.buildStatus(meta, 'unavailable');
        await this.persistMeta(meta);
      }
      return;
    }

    if (!meta.enabled) {
      if (meta.status.state !== 'disabled' || meta.status.enabled || !meta.status.available) {
        meta.status = this.buildStatus(meta, 'disabled');
        await this.persistMeta(meta);
      }
      return;
    }

    const localData = await this.hooks.readRawLocalSnapshot();
    if (localData.hasLocalProjects || localData.hasLocalPrompts) {
      // 本地已有数据时立即返回，后台异步对账以免 SW 冷启动阻塞首屏读取。
      this.scheduleBackgroundInitReconcile();
      return;
    }

    await this.reconcileWithDrive('init');
  }

  private scheduleBackgroundInitReconcile(): void {
    void Promise.resolve().then(() =>
      this.hooks.runSerialized(async () => {
        if (this.disposed || !this.available || !this.localMeta?.enabled) return;
        await this.reconcileWithDrive('init');
      })
    );
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
    meta.tombstones = pruneAndBoundTombstones(meta.tombstones, ts, DRIVE_TOMBSTONES_BYTE_LIMIT);
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
    meta.tombstones = pruneAndBoundTombstones(meta.tombstones, ts, DRIVE_TOMBSTONES_BYTE_LIMIT);
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
    meta.tombstones = pruneAndBoundTombstones(meta.tombstones, ts, DRIVE_TOMBSTONES_BYTE_LIMIT);
    await this.persistMeta(meta);
  }

  public async fetchRemoteSnapshotForRestore(): Promise<SyncSnapshot | null> {
    const meta = await this.ensureMetaLoaded();
    if (!meta.enabled || !this.available) return null;

    try {
      const files = await this.drive!.listSyncFiles();
      if (files.length === 0) return null;

      const readResults = await Promise.all(files.map((file) => this.drive!.readSyncFile(file.id)));
      const projects = new Map<string, SyncProject>();
      const chats = new Map<string, SyncChat>();
      const prompts = new Map<string, SyncPrompt>();
      const tombstones = createEmptyTombstones();
      let validCount = 0;

      for (const readRes of readResults) {
        if (readRes.kind !== 'found') continue;
        const parsed = parseDriveSyncEnvelope(readRes.content);
        if (parsed.kind !== 'valid') continue;
        validCount += 1;
        const snap = parsed.envelope.snapshot;

        for (const p of snap.projects) {
          const prev = projects.get(p.id);
          if (!prev || p.updatedAt > prev.updatedAt) projects.set(p.id, p);
        }
        for (const c of snap.chats) {
          const prev = chats.get(c.id);
          if (!prev || c.updatedAt > prev.updatedAt) chats.set(c.id, c);
        }
        for (const pr of snap.prompts) {
          const prev = prompts.get(pr.id);
          if (!prev || pr.updatedAt > prev.updatedAt) prompts.set(pr.id, pr);
        }
        for (const bucket of ['projects', 'chats', 'prompts'] as const) {
          for (const [id, ts] of Object.entries(snap.tombstones[bucket])) {
            tombstones[bucket][id] = Math.max(tombstones[bucket][id] ?? 0, ts);
          }
        }
      }

      if (validCount === 0) return null;
      return {
        projects: Array.from(projects.values()),
        chats: Array.from(chats.values()),
        prompts: Array.from(prompts.values()),
        tombstones
      };
    } catch {
      return null;
    }
  }

  public async prepareBackupRestore(
    prevState: StoredState,
    prevPrompts: PromptsData | null,
    restoredProjects: StoredState | undefined,
    restoredPrompts: PromptsData | undefined,
    remoteSnapshot?: SyncSnapshot | null
  ): Promise<{ projects?: StoredState; prompts?: PromptsData; nextMeta: SyncLocalMeta; stamp: number }> {
    const meta = await this.ensureMetaLoaded();
    const nextMeta: SyncLocalMeta = {
      ...meta,
      tombstones: {
        projects: { ...meta.tombstones.projects },
        chats: { ...meta.tombstones.chats },
        prompts: { ...meta.tombstones.prompts }
      }
    };

    let maxTs = nextMeta.lastSyncedAt ?? 0;
    for (const ts of Object.values(nextMeta.tombstones.projects)) maxTs = Math.max(maxTs, ts);
    for (const ts of Object.values(nextMeta.tombstones.chats)) maxTs = Math.max(maxTs, ts);
    for (const ts of Object.values(nextMeta.tombstones.prompts)) maxTs = Math.max(maxTs, ts);
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
    if (remoteSnapshot) {
      for (const p of remoteSnapshot.projects) maxTs = Math.max(maxTs, p.updatedAt, p.createdAt);
      for (const c of remoteSnapshot.chats) maxTs = Math.max(maxTs, c.updatedAt);
      for (const p of remoteSnapshot.prompts) maxTs = Math.max(maxTs, p.updatedAt, p.createdAt);
      for (const ts of Object.values(remoteSnapshot.tombstones.projects)) maxTs = Math.max(maxTs, ts);
      for (const ts of Object.values(remoteSnapshot.tombstones.chats)) maxTs = Math.max(maxTs, ts);
      for (const ts of Object.values(remoteSnapshot.tombstones.prompts)) maxTs = Math.max(maxTs, ts);
    }

    const stamp = Math.max(this.clockNow(), maxTs + 1);
    let stampedProjects: StoredState | undefined;
    let stampedPrompts: PromptsData | undefined;

    if (restoredProjects) {
      const nextProjectIds = new Set(restoredProjects.projects.map((p) => p.id));
      for (const prev of prevState.projects) {
        if (!nextProjectIds.has(prev.id)) {
          nextMeta.tombstones.projects[prev.id] = stamp;
        }
      }
      if (remoteSnapshot) {
        for (const remoteProj of remoteSnapshot.projects) {
          if (!nextProjectIds.has(remoteProj.id)) {
            nextMeta.tombstones.projects[remoteProj.id] = stamp;
          }
        }
      }
      for (const id of nextProjectIds) {
        delete nextMeta.tombstones.projects[id];
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
          nextMeta.tombstones.chats[id] = stamp;
        }
      }
      if (remoteSnapshot) {
        for (const remoteChat of remoteSnapshot.chats) {
          if (!nextAssignedChatIds.has(remoteChat.id)) {
            nextMeta.tombstones.chats[remoteChat.id] = stamp;
          }
        }
      }
      for (const id of nextAssignedChatIds) {
        delete nextMeta.tombstones.chats[id];
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
            nextMeta.tombstones.prompts[prevId] = stamp;
          }
        }
      }
      if (remoteSnapshot) {
        for (const remotePrompt of remoteSnapshot.prompts) {
          if (!nextPromptIds.has(remotePrompt.id)) {
            nextMeta.tombstones.prompts[remotePrompt.id] = stamp;
          }
        }
      }
      for (const id of nextPromptIds) {
        delete nextMeta.tombstones.prompts[id];
      }

      const nextPrompts: PromptsData['prompts'] = {};
      for (const [id, prompt] of Object.entries(restoredPrompts.prompts)) {
        nextPrompts[id] = { ...prompt, updatedAt: stamp };
      }
      stampedPrompts = { version: 1, prompts: nextPrompts };
    }

    nextMeta.tombstones = pruneAndBoundTombstones(nextMeta.tombstones, stamp, DRIVE_TOMBSTONES_BYTE_LIMIT);
    // 不在此处提前落盘，由调用方与数据键一起原子写入后再提交内存态。
    return { projects: stampedProjects, prompts: stampedPrompts, nextMeta, stamp };
  }

  public commitPreparedMeta(nextMeta: SyncLocalMeta): void {
    this.localMeta = nextMeta;
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

    if (!meta.enabled) {
      return { ok: true, status: { ...meta.status } };
    }
    if (!this.available) {
      return { ok: false, error: 'Google Drive sync is unavailable.', status: { ...meta.status } };
    }
    return this.reconcileWithDrive('push');
  }

  public async syncNow(): Promise<SyncActionResult> {
    this.cancelDebouncedPush();
    const meta = await this.ensureMetaLoaded();

    if (!this.available) {
      return { ok: false, error: 'Google Drive sync is unavailable.', status: { ...meta.status } };
    }
    if (!meta.enabled) {
      return { ok: false, error: 'Google Drive sync is not connected.', status: { ...meta.status } };
    }
    return this.reconcileWithDrive('manual');
  }

  public async syncIfStale(bypassBackoff = false): Promise<SyncActionResult> {
    const meta = await this.ensureMetaLoaded();
    if (!meta.enabled) {
      return { ok: true, status: { ...meta.status } };
    }
    if (!this.available) {
      return { ok: false, error: 'Google Drive sync is unavailable.', status: { ...meta.status } };
    }
    // 授权过期时等待用户主动重连，不在切回标签页时反复触发静默鉴权。
    if (meta.status.state === 'auth_expired') {
      return { ok: true, status: { ...meta.status } };
    }
    const now = this.clockNow();
    const lastCheck = Math.max(this.lastDriveAttemptAt, meta.lastSyncedAt ?? 0);
    const effectiveIntervalMs = bypassBackoff
      ? 0
      : this.staleIntervalMs * (2 ** this.consecutiveErrorCount);
    const elapsed = now - lastCheck;
    if (!bypassBackoff && lastCheck > 0 && elapsed >= 0 && elapsed < effectiveIntervalMs) {
      return { ok: true, status: { ...meta.status } };
    }
    return this.reconcileWithDrive('stale');
  }

  public async connectGoogleDrive(): Promise<SyncActionResult> {
    this.cancelDebouncedPush();
    const meta = await this.ensureMetaLoaded();
    this.initialized = true;

    if (!this.available) {
      return {
        ok: false,
        error: 'Google Drive sync is unavailable in this browser.',
        status: { ...meta.status }
      };
    }

    try {
      // 先完成用户交互授权再启用同步，取消或失败时保持当前状态不变。
      await this.drive!.authenticate(true);
    } catch (error) {
      const message = error instanceof Error && error.message
        ? error.message
        : 'Google Drive sign-in failed.';
      return { ok: false, error: message, status: { ...meta.status } };
    }

    this.consecutiveErrorCount = 0;
    meta.enabled = true;
    meta.status = this.buildStatus(meta, 'syncing', {
      bytesUsed: meta.status.bytesUsed
    });
    await this.persistMeta(meta);

    return this.reconcileWithDrive('connect');
  }

  public async disconnectGoogleDrive(): Promise<SyncActionResult> {
    this.cancelDebouncedPush();
    this.consecutiveErrorCount = 0;
    const meta = await this.ensureMetaLoaded();
    this.initialized = true;

    await this.drive?.clearToken();
    meta.enabled = false;
    meta.status = this.buildStatus(meta, this.available ? 'disabled' : 'unavailable');
    await this.persistMeta(meta);
    return { ok: true, status: { ...meta.status } };
  }

  private finishReconcile(result: SyncActionResult): SyncActionResult {
    if (result.ok) {
      this.consecutiveErrorCount = 0;
    } else if (result.status.state === 'error') {
      this.consecutiveErrorCount = Math.min(this.consecutiveErrorCount + 1, 3);
    } else {
      this.consecutiveErrorCount = 0;
    }
    return result;
  }

  private async reconcileWithDrive(
    mode: 'init' | 'connect' | 'manual' | 'stale' | 'push'
  ): Promise<SyncActionResult> {
    const meta = await this.ensureMetaLoaded();
    if (!meta.enabled || !this.available) {
      return { ok: false, error: 'Google Drive sync is not active.', status: { ...meta.status } };
    }

    this.lastDriveAttemptAt = this.clockNow();

    if (mode === 'manual') {
      meta.status = this.buildStatus(meta, 'syncing', { bytesUsed: meta.status.bytesUsed });
      await this.persistMeta(meta);
    }

    try {
      const localData = await this.hooks.readRawLocalSnapshot();
      const now = this.clockNow();

      // 写入快速路径：命中已缓存 driveFileId 时直接读取并对账，404 则回退完整列举。
      if (mode === 'push' && meta.driveFileId) {
        const fastResult = await this.tryFastDrivePush(meta, localData, now);
        if (fastResult !== null) return this.finishReconcile(fastResult);
      }

      const files = await this.drive!.listSyncFiles();

      if (files.length === 0) {
        meta.driveFileId = undefined;
        meta.driveLastModifiedTime = undefined;
        meta.driveLastVersion = undefined;

        if (mode === 'init' && !localData.hasLocalProjects && !localData.hasLocalPrompts) {
          if (meta.status.state !== 'synced') {
            meta.status = this.buildStatus(meta, 'synced');
            await this.persistMeta(meta);
          }
          return this.finishReconcile({ ok: true, status: { ...meta.status } });
        }

        const snapshot = extractSyncSnapshot(
          localData.state,
          localData.hasLocalPrompts ? localData.prompts : null,
          meta.tombstones,
          now,
          DRIVE_TOMBSTONES_BYTE_LIMIT
        );
        const hash = computeSnapshotHash(snapshot);
        const nextRev = meta.lastSyncedRev + 1;
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
        meta.driveLastVersion = created.version;
        meta.lastSyncedRev = nextRev;
        meta.lastSyncedHash = hash;
        meta.lastSyncedAt = now;
        meta.tombstones = snapshot.tombstones;
        meta.status = this.buildStatus(meta, 'synced', {
          lastSyncedAt: now,
          bytesUsed: utf8ByteLength(json)
        });
        await this.persistMeta(meta);
        return this.finishReconcile({ ok: true, status: { ...meta.status } });
      }

      // 焦点轻量检查：若单文件 modifiedTime 与 version 均未变且本地快照哈希与上次一致，跳过下载。
      const versionMatches =
        (!files[0].version && !meta.driveLastVersion) ||
        (Boolean(files[0].version) && files[0].version === meta.driveLastVersion);
      if (
        mode === 'stale' &&
        files.length === 1 &&
        files[0].id === meta.driveFileId &&
        files[0].modifiedTime &&
        files[0].modifiedTime === meta.driveLastModifiedTime &&
        versionMatches &&
        meta.lastSyncedHash
      ) {
        const localSnapshot = extractSyncSnapshot(
          localData.state,
          localData.hasLocalPrompts ? localData.prompts : null,
          meta.tombstones,
          now,
          DRIVE_TOMBSTONES_BYTE_LIMIT
        );
        if (computeSnapshotHash(localSnapshot) === meta.lastSyncedHash) {
          if (meta.status.state !== 'synced') {
            meta.status = this.buildStatus(meta, 'synced', {
              lastSyncedAt: meta.lastSyncedAt ?? now,
              bytesUsed: meta.status.bytesUsed
            });
            await this.persistMeta(meta);
          }
          return this.finishReconcile({ ok: true, status: { ...meta.status } });
        }
      }

      if (files.length === 1) {
        return this.finishReconcile(await this.reconcileSingleDriveFile(meta, files[0], localData, now));
      }

      // 并发冷启动产生多份同名同步文件时，合并全部有效副本到最旧主文件并清理多余副本。
      return this.finishReconcile(await this.healDuplicateDriveFiles(meta, files, localData, now));
    } catch (error) {
      const classified = classifyDriveError(error);
      meta.status = this.buildStatus(meta, classified.state, {
        lastError: classified.message,
        bytesUsed: meta.status.bytesUsed
      });
      await this.persistMeta(meta);
      return this.finishReconcile({ ok: false, error: classified.message, status: { ...meta.status } });
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
      meta.driveLastVersion = undefined;
      return null;
    }
    if (readRes.kind === 'corrupt') {
      meta.status = this.buildStatus(meta, 'error', {
        lastError: readRes.reason,
        bytesUsed: meta.status.bytesUsed
      });
      await this.persistMeta(meta);
      return { ok: false, error: readRes.reason, status: { ...meta.status } };
    }

    const parsed = parseDriveSyncEnvelope(readRes.content);
    if (parsed.kind === 'invalid') {
      meta.status = this.buildStatus(meta, 'error', {
        lastError: parsed.reason,
        bytesUsed: meta.status.bytesUsed
      });
      await this.persistMeta(meta);
      return { ok: false, error: parsed.reason, status: { ...meta.status } };
    }

    const remoteEnv = parsed.envelope;
    const isEcho =
      remoteEnv.clientId === meta.clientId &&
      remoteEnv.rev === meta.lastSyncedRev &&
      remoteEnv.hash === meta.lastSyncedHash;

    let stateToPush = localData.state;
    let promptsToPush: PromptsData | null = localData.hasLocalPrompts ? localData.prompts : null;
    let tombstonesToPush = meta.tombstones;

    if (!isEcho && remoteEnv.hash !== meta.lastSyncedHash) {
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
      meta.lastSyncedRev = remoteEnv.rev;
      meta.lastSyncedHash = remoteEnv.hash;
      meta.lastSyncedAt = now;
      meta.tombstones = snapshot.tombstones;
      meta.status = this.buildStatus(meta, 'synced', {
        lastSyncedAt: now,
        bytesUsed: readRes.rawBytes
      });
      await this.persistMeta(meta);
      return { ok: true, status: { ...meta.status } };
    }

    const nextRev = Math.max(meta.lastSyncedRev, remoteEnv.rev) + 1;
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
      meta.driveLastVersion = undefined;
      return null;
    }

    meta.driveFileId = fileId;
    meta.driveLastModifiedTime = patchRes.modifiedTime;
    meta.driveLastVersion = patchRes.version;
    meta.lastSyncedRev = nextRev;
    meta.lastSyncedHash = hash;
    meta.lastSyncedAt = now;
    meta.tombstones = snapshot.tombstones;
    meta.status = this.buildStatus(meta, 'synced', {
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
      const nextRev = meta.lastSyncedRev + 1;
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
      meta.driveLastVersion = created.version;
      meta.lastSyncedRev = nextRev;
      meta.lastSyncedHash = hash;
      meta.lastSyncedAt = now;
      meta.tombstones = snapshot.tombstones;
      meta.status = this.buildStatus(meta, 'synced', {
        lastSyncedAt: now,
        bytesUsed: utf8ByteLength(json)
      });
      await this.persistMeta(meta);
      return { ok: true, status: { ...meta.status } };
    }

    if (readRes.kind === 'corrupt') {
      meta.status = this.buildStatus(meta, 'error', {
        lastError: readRes.reason,
        bytesUsed: meta.status.bytesUsed
      });
      await this.persistMeta(meta);
      return { ok: false, error: readRes.reason, status: { ...meta.status } };
    }

    const parsed = parseDriveSyncEnvelope(readRes.content);
    if (parsed.kind === 'invalid') {
      meta.status = this.buildStatus(meta, 'error', {
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
      meta.driveLastVersion = primary.version;
      meta.lastSyncedRev = remoteEnv.rev;
      meta.lastSyncedHash = remoteEnv.hash;
      meta.lastSyncedAt = now;
      meta.tombstones = mergedSnapshot.tombstones;
      meta.status = this.buildStatus(meta, 'synced', {
        lastSyncedAt: now,
        bytesUsed: readRes.rawBytes
      });
      await this.persistMeta(meta);
      return { ok: true, status: { ...meta.status } };
    }

    const nextRev = Math.max(meta.lastSyncedRev, remoteEnv.rev) + 1;
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
    let finalVersion = patchRes.notFound ? undefined : patchRes.version;
    if (patchRes.notFound) {
      const created = await this.drive!.createSyncFile(json);
      finalFileId = created.id;
      finalModifiedTime = created.modifiedTime;
      finalVersion = created.version;
    }

    meta.driveFileId = finalFileId;
    meta.driveLastModifiedTime = finalModifiedTime;
    meta.driveLastVersion = finalVersion;
    meta.lastSyncedRev = nextRev;
    meta.lastSyncedHash = hash;
    meta.lastSyncedAt = now;
    meta.tombstones = mergedSnapshot.tombstones;
    meta.status = this.buildStatus(meta, 'synced', {
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
      meta.status = this.buildStatus(meta, 'error', {
        lastError: reason,
        bytesUsed: meta.status.bytesUsed
      });
      await this.persistMeta(meta);
      return { ok: false, error: reason, status: { ...meta.status } };
    }

    let currentState = localData.state;
    let currentPrompts = localData.prompts;
    let currentTombstones = meta.tombstones;
    let maxRemoteRev = meta.lastSyncedRev;
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
    const nextRev = Math.max(meta.lastSyncedRev, maxRemoteRev) + 1;
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
    let finalVersion = patchRes.notFound ? undefined : patchRes.version;
    if (patchRes.notFound) {
      const created = await this.drive!.createSyncFile(json);
      finalFileId = created.id;
      finalModifiedTime = created.modifiedTime;
      finalVersion = created.version;
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
    meta.driveLastVersion = finalVersion;
    meta.lastSyncedRev = nextRev;
    meta.lastSyncedHash = hash;
    meta.lastSyncedAt = now;
    meta.tombstones = mergedSnapshot.tombstones;
    meta.status = this.buildStatus(meta, 'synced', {
      lastSyncedAt: now,
      bytesUsed: utf8ByteLength(json)
    });
    await this.persistMeta(meta);
    return { ok: true, status: { ...meta.status } };
  }

  public dispose(): void {
    this.disposed = true;
    this.cancelDebouncedPush();
  }
}
