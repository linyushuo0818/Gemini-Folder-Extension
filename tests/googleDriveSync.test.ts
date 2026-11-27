import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundService, BackgroundService } from '../src/background/service';
import { StorageAreaLike } from '../src/background/cloudSync';
import {
  DRIVE_SESSION_EXPIRED_MESSAGE,
  DriveApiError,
  DriveAuthToken,
  GOOGLE_DRIVE_CLIENT_ID,
  GOOGLE_DRIVE_SCOPE,
  GoogleDriveSyncClient,
  IdentityAuthLike
} from '../src/background/googleDriveSync';
import {
  computeSnapshotHash,
  createEmptyTombstones,
  DRIVE_AUTH_STORAGE_KEY,
  DRIVE_SYNC_FILENAME,
  DriveSyncEnvelopeV1,
  mergeSyncData,
  projectToSync,
  sanitizeLocalMeta,
  SYNC_LOCAL_META_KEY,
  SYNC_STALE_INTERVAL_MS,
  SyncLocalMeta,
  SyncPrompt,
  SyncSnapshot
} from '../src/shared/sync';
import { CURRENT_SCHEMA_VERSION, STORAGE_KEY } from '../src/shared/storage';
import { createSeedData, PROMPTS_KEY } from '../src/shared/prompts';
import { Project, StoredState } from '../src/shared/types';

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

class MockLocalStorage implements StorageAreaLike {
  public data: Record<string, unknown> = {};

  async get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
    if (keys === undefined || keys === null) return clone(this.data);
    if (typeof keys === 'string') {
      return Object.hasOwn(this.data, keys) ? { [keys]: clone(this.data[keys]) } : {};
    }
    if (Array.isArray(keys)) {
      const out: Record<string, unknown> = {};
      for (const k of keys) {
        if (Object.hasOwn(this.data, k)) out[k] = clone(this.data[k]);
      }
      return out;
    }
    const out: Record<string, unknown> = {};
    for (const [k, def] of Object.entries(keys)) {
      out[k] = Object.hasOwn(this.data, k) ? clone(this.data[k]) : clone(def);
    }
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) {
      this.data[k] = clone(v);
    }
  }

  async remove(keys: string | string[]): Promise<void> {
    for (const k of Array.isArray(keys) ? keys : [keys]) {
      delete this.data[k];
    }
  }
}

interface StoredDriveFile {
  id: string;
  name: string;
  parents: string[];
  createdTime: number;
  modifiedTime: string;
  version: number;
  content: string;
}

interface InjectedDriveFault {
  status?: number;
  throwError?: Error;
  delayMs?: number;
  retryAfter?: string;
}

class MockGoogleDriveServer {
  public files: StoredDriveFile[] = [];
  public validTokens = new Set<string>();
  public failNextRequests: InjectedDriveFault[] = [];
  public accountEmail = 'sync-owner@example.com';
  public aboutCalls = 0;
  public listCalls = 0;
  public readCalls = 0;
  public createCalls = 0;
  public updateCalls = 0;
  public deleteCalls = 0;
  public totalRequests = 0;
  private fileSeq = 0;
  private modSeq = 0;

  public seedFile(content: string, createdTime = 1000): StoredDriveFile {
    this.fileSeq += 1;
    this.modSeq += 1;
    const file: StoredDriveFile = {
      id: `drive_file_${this.fileSeq}`,
      name: DRIVE_SYNC_FILENAME,
      parents: ['appDataFolder'],
      createdTime,
      modifiedTime: `2026-11-27T00:00:${String(this.modSeq).padStart(2, '0')}.000Z`,
      version: 1,
      content
    };
    this.files.push(file);
    return file;
  }

  public revokeAllTokens(): void {
    this.validTokens.clear();
  }

  private pickRequestedFields(file: StoredDriveFile, fields: Set<string>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (fields.size === 0 || fields.has('id')) out.id = file.id;
    if (fields.has('modifiedTime')) out.modifiedTime = file.modifiedTime;
    if (fields.has('version')) out.version = String(file.version);
    return out;
  }

  public fetchImpl: typeof fetch = async (input, init = {}) => {
    this.totalRequests += 1;
    const fault = this.failNextRequests.shift();
    if (fault?.delayMs && fault.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        if (init.signal?.aborted) {
          reject(new DOMException('The operation was aborted', 'AbortError'));
          return;
        }
        const onAbort = () => {
          clearTimeout(timer);
          reject(new DOMException('The operation was aborted', 'AbortError'));
        };
        const timer = setTimeout(() => {
          init.signal?.removeEventListener('abort', onAbort);
          resolve();
        }, fault.delayMs);
        init.signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    if (fault?.throwError) {
      throw fault.throwError;
    }
    if (fault?.status) {
      return new Response(
        JSON.stringify({ error: { code: fault.status, message: 'Injected fault' } }),
        {
          status: fault.status,
          headers: {
            'Content-Type': 'application/json',
            ...(fault.retryAfter !== undefined ? { 'Retry-After': fault.retryAfter } : {})
          }
        }
      );
    }

    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(urlStr);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const auth = headers.get('Authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';

    if (!token || !this.validTokens.has(token)) {
      return new Response(JSON.stringify({ error: { code: 401, message: 'Invalid Credentials' } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Drive about user info (resolves account email for silent multi-account login_hint)
    if (method === 'GET' && url.pathname === '/drive/v3/about') {
      this.aboutCalls += 1;
      const fieldsParam = url.searchParams.get('fields') || '';
      assert.ok(fieldsParam.includes('user(emailAddress)'), 'About request must request user(emailAddress)');
      return new Response(JSON.stringify({ user: { emailAddress: this.accountEmail } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // List files in appDataFolder (enforces real Drive v3 `fields=files(...)` selection)
    if (method === 'GET' && url.pathname === '/drive/v3/files') {
      this.listCalls += 1;
      assert.equal(url.searchParams.get('spaces'), 'appDataFolder');
      const fieldsParam = url.searchParams.get('fields') || '';
      const listFieldsMatch = /files\(([^)]+)\)/.exec(fieldsParam);
      const requested = new Set(
        (listFieldsMatch ? listFieldsMatch[1] : '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      );
      const matching = [...this.files]
        .filter((f) => f.name === DRIVE_SYNC_FILENAME && f.parents.includes('appDataFolder'))
        .sort((a, b) => a.createdTime - b.createdTime)
        .map((f) => this.pickRequestedFields(f, requested));
      return new Response(JSON.stringify({ files: matching }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Read file content
    if (method === 'GET' && url.pathname.startsWith('/drive/v3/files/') && url.searchParams.get('alt') === 'media') {
      this.readCalls += 1;
      const id = decodeURIComponent(url.pathname.slice('/drive/v3/files/'.length));
      const file = this.files.find((f) => f.id === id);
      if (!file) {
        return new Response(JSON.stringify({ error: { code: 404, message: 'File not found' } }), { status: 404 });
      }
      return new Response(file.content, {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Create file (multipart/related; enforces real Drive v3 `fields=...` selection)
    if (method === 'POST' && url.pathname === '/upload/drive/v3/files') {
      this.createCalls += 1;
      assert.equal(url.searchParams.get('uploadType'), 'multipart');
      const contentType = headers.get('Content-Type') || '';
      const boundaryMatch = /boundary=([^;]+)/.exec(contentType);
      assert.ok(boundaryMatch, 'Multipart Content-Type must specify boundary');
      const boundary = boundaryMatch[1];
      const rawBody = typeof init.body === 'string' ? init.body : '';
      const parts = rawBody.split(`--${boundary}`).filter((p) => p.includes('\r\n\r\n'));
      assert.equal(parts.length, 2, 'Multipart upload must contain metadata and media parts');
      const metaJson = JSON.parse(parts[0].split('\r\n\r\n')[1].trim()) as { name: string; parents: string[] };
      const mediaText = parts[1].split('\r\n\r\n')[1].replace(/\r\n$/, '');
      assert.equal(metaJson.name, DRIVE_SYNC_FILENAME);
      assert.deepEqual(metaJson.parents, ['appDataFolder']);

      this.fileSeq += 1;
      this.modSeq += 1;
      const file: StoredDriveFile = {
        id: `drive_file_${this.fileSeq}`,
        name: metaJson.name,
        parents: metaJson.parents,
        createdTime: Date.now() + this.fileSeq,
        modifiedTime: `2026-11-27T00:00:${String(this.modSeq).padStart(2, '0')}.000Z`,
        version: 1,
        content: mediaText
      };
      this.files.push(file);
      const requested = new Set(
        (url.searchParams.get('fields') || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      );
      return new Response(JSON.stringify(this.pickRequestedFields(file, requested)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Update file (PATCH uploadType=media; enforces real Drive v3 `fields=...` selection)
    if (method === 'PATCH' && url.pathname.startsWith('/upload/drive/v3/files/')) {
      this.updateCalls += 1;
      assert.equal(url.searchParams.get('uploadType'), 'media');
      const id = decodeURIComponent(url.pathname.slice('/upload/drive/v3/files/'.length));
      const file = this.files.find((f) => f.id === id);
      if (!file) {
        return new Response(JSON.stringify({ error: { code: 404, message: 'File not found' } }), { status: 404 });
      }
      this.modSeq += 1;
      file.content = typeof init.body === 'string' ? init.body : '';
      file.modifiedTime = `2026-11-27T00:00:${String(this.modSeq).padStart(2, '0')}.000Z`;
      file.version += 1;
      const requested = new Set(
        (url.searchParams.get('fields') || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      );
      return new Response(JSON.stringify(this.pickRequestedFields(file, requested)), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Delete file
    if (method === 'DELETE' && url.pathname.startsWith('/drive/v3/files/')) {
      this.deleteCalls += 1;
      const id = decodeURIComponent(url.pathname.slice('/drive/v3/files/'.length));
      const idx = this.files.findIndex((f) => f.id === id);
      if (idx === -1) {
        return new Response(null, { status: 404 });
      }
      this.files.splice(idx, 1);
      return new Response(null, { status: 204 });
    }

    return new Response(`Unhandled ${method} ${url.href}`, { status: 400 });
  };
}

class MockIdentityProvider implements IdentityAuthLike {
  public interactiveCalls = 0;
  public silentCalls = 0;
  public lastAuthUrl: URL | null = null;
  public nextInteractiveBehavior: 'ok' | 'cancel' | 'bad_state' | 'access_denied' = 'ok';
  public nextSilentBehavior: 'ok' | 'fail' | 'interaction_required' = 'ok';
  public tokenLifetimeSec = 3600;
  private tokenSeq = 0;

  constructor(
    private readonly server: MockGoogleDriveServer,
    private readonly extensionId = 'kiifegldibkapobmpjmcnpgeiclofijl'
  ) {}

  public getRedirectURL(path = ''): string {
    return `https://${this.extensionId}.chromiumapp.org/${path}`;
  }

  public async launchWebAuthFlow(details: { url: string; interactive: boolean }): Promise<string | undefined> {
    const authUrl = new URL(details.url);
    this.lastAuthUrl = authUrl;
    const state = authUrl.searchParams.get('state') || '';
    const redirectUri = authUrl.searchParams.get('redirect_uri') || this.getRedirectURL();

    if (details.interactive) {
      this.interactiveCalls += 1;
      const behavior = this.nextInteractiveBehavior;
      this.nextInteractiveBehavior = 'ok';
      if (behavior === 'cancel') {
        throw new Error('The user did not approve access.');
      }
      if (behavior === 'access_denied') {
        return `${redirectUri}#error=access_denied&state=${encodeURIComponent(state)}`;
      }
      this.tokenSeq += 1;
      const token = `tok_${this.extensionId}_${this.tokenSeq}`;
      this.server.validTokens.add(token);
      const returnedState = behavior === 'bad_state' ? 'tampered-csrf-state' : state;
      return `${redirectUri}#access_token=${encodeURIComponent(token)}&token_type=Bearer&expires_in=${this.tokenLifetimeSec}&state=${encodeURIComponent(returnedState)}`;
    }

    this.silentCalls += 1;
    assert.equal(authUrl.searchParams.get('prompt'), 'none', 'Silent renewal must pass prompt=none');
    const behavior = this.nextSilentBehavior;
    if (behavior === 'fail') {
      throw new Error('Authorization page could not be loaded.');
    }
    if (behavior === 'interaction_required') {
      return `${redirectUri}#error=interaction_required&state=${encodeURIComponent(state)}`;
    }
    this.tokenSeq += 1;
    const token = `tok_silent_${this.extensionId}_${this.tokenSeq}`;
    this.server.validTokens.add(token);
    return `${redirectUri}#access_token=${encodeURIComponent(token)}&token_type=Bearer&expires_in=${this.tokenLifetimeSec}&state=${encodeURIComponent(state)}`;
  }
}

function createClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    tick: (ms = 100) => {
      current += ms;
      return current;
    }
  };
}

function makeProject(id: string, name: string, ts: number, overrides: Partial<Project> = {}): Project {
  return {
    id,
    name,
    icon: 'coding',
    iconStyle: 'duotone',
    useIconPalette: true,
    isPinned: false,
    createdAt: ts,
    updatedAt: ts,
    sortIndex: ts,
    ...overrides
  };
}

interface DriveTestDevice {
  local: MockLocalStorage;
  identity: MockIdentityProvider;
  service: BackgroundService;
  restartSw: () => void;
  dispose: () => void;
}

function createDriveDevice(
  server: MockGoogleDriveServer,
  clock: { now: () => number },
  opts: {
    local?: MockLocalStorage;
    extensionId?: string;
    driveUnavailable?: boolean;
    debounceMs?: number;
    staleIntervalMs?: number;
    requestTimeoutMs?: number;
    uploadTimeoutMs?: number;
    retryDelayMs?: number;
  } = {}
): DriveTestDevice {
  const local = opts.local ?? new MockLocalStorage();
  const identity = new MockIdentityProvider(server, opts.extensionId);
  let service: BackgroundService;

  const boot = () => {
    const drive = opts.driveUnavailable
      ? null
      : new GoogleDriveSyncClient({
          local,
          identity,
          fetchImpl: server.fetchImpl,
          now: clock.now,
          requestTimeoutMs: opts.requestTimeoutMs,
          uploadTimeoutMs: opts.uploadTimeoutMs,
          retryDelayMs: opts.retryDelayMs
        });
    service = createBackgroundService({
      local,
      drive,
      now: clock.now,
      debounceMs: opts.debounceMs ?? 30,
      staleIntervalMs: opts.staleIntervalMs ?? SYNC_STALE_INTERVAL_MS
    });
  };

  boot();

  return {
    local,
    identity,
    get service() {
      return service;
    },
    restartSw: () => {
      service.dispose();
      boot();
    },
    dispose: () => service.dispose()
  };
}

// 1. Default local-only mode (enabled: false): startup & local mutations make 0 Drive/OAuth calls
test('1. Default local-only mode: startup and local mutations make zero Drive or OAuth calls', async () => {
  const clock = createClock();
  const server = new MockGoogleDriveServer();
  const device = createDriveDevice(server, clock, { debounceMs: 15 });

  await device.service.initialize();
  const initialStatus = (await device.service.handleMessage({ type: 'getSyncStatus' })).syncStatus!;
  assert.equal(initialStatus.enabled, false);
  assert.equal(initialStatus.available, true);
  assert.equal(initialStatus.state, 'disabled');
  assert.equal(initialStatus.lastSyncedAt, null);

  // Perform every local mutation while disconnected
  assert.equal((await device.service.handleMessage({ type: 'getPrompts' })).ok, true);
  assert.equal(
    (
      await device.service.handleMessage({
        type: 'upsertProject',
        project: makeProject('p-local', 'Local Only', clock.tick(10)),
        editing: false
      })
    ).ok,
    true
  );
  assert.equal(
    (
      await device.service.handleMessage({
        type: 'moveChat',
        conversationId: 'chat-local',
        projectId: 'p-local',
        metadata: { conversationId: 'chat-local', title: 'Local Chat', lastUrl: 'https://gemini.google.com/app/chat-local' }
      })
    ).ok,
    true
  );
  assert.equal(
    (
      await device.service.handleMessage({
        type: 'upsertChatRefs',
        chats: [{ conversationId: 'chat-local', title: 'Renamed Locally', lastUrl: 'https://gemini.google.com/app/chat-local' }]
      })
    ).ok,
    true
  );
  assert.equal((await device.service.handleMessage({ type: 'savePrompt', prompt: { title: 'My Local Prompt', content: 'Body' } })).ok, true);
  assert.equal((await device.service.handleMessage({ type: 'syncIfStale' })).ok, true);

  await new Promise((r) => setTimeout(r, 40));

  // syncNow when disconnected returns a clean error without any network/OAuth calls
  const syncNowRes = await device.service.handleMessage({ type: 'syncNow' });
  assert.equal(syncNowRes.ok, false);

  assert.equal(server.totalRequests, 0, 'Local-only mode must make 0 Drive API calls');
  assert.equal(device.identity.interactiveCalls, 0, 'Local-only mode must make 0 interactive OAuth calls');
  assert.equal(device.identity.silentCalls, 0, 'Local-only mode must make 0 silent OAuth calls');
  assert.equal(device.local.data[DRIVE_AUTH_STORAGE_KEY], undefined);

  // When Identity API is unavailable, status reports unavailable cleanly
  const unavailableDevice = createDriveDevice(server, clock, { driveUnavailable: true });
  const unavailStatus = (await unavailableDevice.service.handleMessage({ type: 'getSyncStatus' })).syncStatus!;
  assert.equal(unavailStatus.enabled, false);
  assert.equal(unavailStatus.available, false);
  assert.equal(unavailStatus.state, 'unavailable');
  assert.equal((await unavailableDevice.service.handleMessage({ type: 'connectGoogleDrive' })).ok, false);

  device.dispose();
  unavailableDevice.dispose();
});

// 2. Connect Google Drive: OAuth CSRF validation, cancel stays disabled, cold-start local-only push,
//    remote-only pull without duplicate seed prompts, and both-have-data union merge
test('2. Connect Google Drive: CSRF validation, cancel stays disabled, local-only push, remote-only pull, and union merge', async () => {
  const clock = createClock();
  const server = new MockGoogleDriveServer();

  // 2a. Cold-start local-only push when Drive is empty
  const deviceA = createDriveDevice(server, clock);
  await deviceA.service.handleMessage({
    type: 'upsertProject',
    project: makeProject('p-local-a', 'From Device A', clock.tick(10)),
    editing: false
  });
  await deviceA.service.handleMessage({
    type: 'savePrompt',
    prompt: { title: 'Prompt A', content: 'Body A' }
  });

  // Cancelled OAuth keeps enabled=false and stores no token
  deviceA.identity.nextInteractiveBehavior = 'cancel';
  const cancelRes = await deviceA.service.handleMessage({ type: 'connectGoogleDrive' });
  assert.equal(cancelRes.ok, false);
  assert.equal(cancelRes.syncStatus?.enabled, false);
  assert.equal(cancelRes.syncStatus?.state, 'disabled');
  assert.equal(deviceA.local.data[DRIVE_AUTH_STORAGE_KEY], undefined);

  // CSRF state mismatch is rejected and keeps enabled=false
  deviceA.identity.nextInteractiveBehavior = 'bad_state';
  const badStateRes = await deviceA.service.handleMessage({ type: 'connectGoogleDrive' });
  assert.equal(badStateRes.ok, false);
  assert.equal(badStateRes.syncStatus?.enabled, false);
  assert.equal(badStateRes.syncStatus?.state, 'disabled');
  assert.equal(deviceA.local.data[DRIVE_AUTH_STORAGE_KEY], undefined);

  // Successful connect pushes local-only data to Drive and verifies OAuth URL parameters
  const connectARes = await deviceA.service.handleMessage({ type: 'connectGoogleDrive' });
  assert.equal(connectARes.ok, true);
  assert.equal(connectARes.syncStatus?.enabled, true);
  assert.equal(connectARes.syncStatus?.available, true);
  assert.equal(connectARes.syncStatus?.state, 'synced');
  assert.ok(deviceA.local.data[DRIVE_AUTH_STORAGE_KEY], 'Token must be persisted under gp_drive_auth_v1');
  assert.equal(server.files.length, 1);
  assert.equal(server.files[0].content.includes('tok_'), false, 'OAuth token must never appear in sync payload');

  const authUrl = deviceA.identity.lastAuthUrl!;
  assert.equal(authUrl.searchParams.get('client_id'), GOOGLE_DRIVE_CLIENT_ID);
  assert.equal(authUrl.searchParams.get('scope'), GOOGLE_DRIVE_SCOPE);
  assert.equal(authUrl.searchParams.get('response_type'), 'token');
  assert.equal(authUrl.searchParams.get('include_granted_scopes'), 'true');
  assert.equal(authUrl.searchParams.get('prompt'), null, 'Interactive OAuth must not set prompt=none');
  assert.ok(authUrl.searchParams.get('state'));

  // 2b. Fresh device (remote-only pull) pulls remote data without generating duplicate seed prompts
  const promptsA = (await deviceA.service.handleMessage({ type: 'getPrompts' })).prompts!;
  const expectedPromptIds = Object.keys(promptsA.prompts).sort();
  const deviceFresh = createDriveDevice(server, clock);
  const connectFreshRes = await deviceFresh.service.handleMessage({ type: 'connectGoogleDrive' });
  assert.equal(connectFreshRes.ok, true);
  const freshState = (await deviceFresh.service.handleMessage({ type: 'getState' })).state!;
  const freshPrompts = (await deviceFresh.service.handleMessage({ type: 'getPrompts' })).prompts!;
  assert.deepEqual(freshState.projects.map((p) => p.id), ['p-local-a']);
  assert.deepEqual(Object.keys(freshPrompts.prompts).sort(), expectedPromptIds, 'Fresh device must not duplicate seed prompts');

  // 2c. Both-have-data union merge when a third device already has local projects & prompts
  const deviceC = createDriveDevice(server, clock);
  await deviceC.service.handleMessage({
    type: 'upsertProject',
    project: makeProject('p-local-c', 'From Device C', clock.tick(10)),
    editing: false
  });
  await deviceC.service.handleMessage({
    type: 'savePrompt',
    prompt: { title: 'Prompt C', content: 'Body C' }
  });
  const connectCRes = await deviceC.service.handleMessage({ type: 'connectGoogleDrive' });
  assert.equal(connectCRes.ok, true);
  const stateC = (await deviceC.service.handleMessage({ type: 'getState' })).state!;
  const promptsC = (await deviceC.service.handleMessage({ type: 'getPrompts' })).prompts!;
  assert.deepEqual(stateC.projects.map((p) => p.id).sort(), ['p-local-a', 'p-local-c']);
  assert.ok(Object.values(promptsC.prompts).some((p) => p.title === 'Prompt A'));
  assert.ok(Object.values(promptsC.prompts).some((p) => p.title === 'Prompt C'));

  deviceA.dispose();
  deviceFresh.dispose();
  deviceC.dispose();
});

// 3. Multi-device cross-browser concurrent edits, commutative LWW tie-break, large >100 KB prompts,
//    local-only preservation (uiPrefs, unassigned chats, usageCount/lastUsedAt), debounced assigned chat metadata sync
test('3. Cross-browser sync: concurrent edits, commutative LWW tie-break, >100KB prompts, local-only data, debounced chat sync', async () => {
  const clock = createClock();
  const server = new MockGoogleDriveServer();

  // Commutative LWW tie-break unit verification (same updatedAt -> identical winner in both merge directions)
  const tieTs = clock.now();
  const projA = makeProject('p-tie', 'Name Alpha', tieTs);
  const projB = makeProject('p-tie', 'Name Beta', tieTs);
  const baseState = (project: Project): StoredState => ({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projects: [project],
    chatIndex: {},
    uiPrefs: { projectsCollapsed: false }
  });
  const emptyPrompts = { version: 1 as const, prompts: {} };
  const ab = mergeSyncData(
    baseState(projA),
    emptyPrompts,
    createEmptyTombstones(),
    { projects: [projectToSync(projB)], chats: [], prompts: [], tombstones: createEmptyTombstones() },
    tieTs
  );
  const ba = mergeSyncData(
    baseState(projB),
    emptyPrompts,
    createEmptyTombstones(),
    { projects: [projectToSync(projA)], chats: [], prompts: [], tombstones: createEmptyTombstones() },
    tieTs
  );
  assert.equal(ab.state.projects[0].name, ba.state.projects[0].name, 'LWW tie-breaker must be strictly commutative');

  const aside = createDriveDevice(server, clock, {
    extensionId: 'kiifegldibkapobmpjmcnpgeiclofijl',
    debounceMs: 25
  });
  const chrome = createDriveDevice(server, clock, {
    extensionId: 'okjjhdoncledadkchbbbcddpopbbgbic',
    debounceMs: 25
  });

  assert.equal((await aside.service.handleMessage({ type: 'connectGoogleDrive' })).ok, true);
  assert.equal((await chrome.service.handleMessage({ type: 'connectGoogleDrive' })).ok, true);

  await aside.service.handleMessage({
    type: 'upsertProject',
    project: makeProject('p-research', 'Research', clock.tick(10)),
    editing: false
  });
  await aside.service.handleMessage({
    type: 'moveChat',
    conversationId: 'conv-42',
    projectId: 'p-research',
    metadata: {
      conversationId: 'conv-42',
      title: 'Initial Title',
      lastUrl: 'https://gemini.google.com/u/2/app/conv-42'
    }
  });
  // Local-only data: uiPrefs, unassigned chat, prompt usageCount/lastUsedAt
  await aside.service.handleMessage({ type: 'updateUiPrefs', prefs: { projectsCollapsed: true } });
  await aside.service.handleMessage({
    type: 'upsertChatRefs',
    chats: [{ conversationId: 'local-only', title: 'Noise', lastUrl: 'https://gemini.google.com/app/local-only' }]
  });

  // Save 6 huge prompts (22 KB each => >132 KB total)
  for (let i = 0; i < 6; i += 1) {
    clock.tick(10);
    const res = await aside.service.handleMessage({
      type: 'savePrompt',
      prompt: { title: `Big Prompt ${i}`, content: `P${i}-` + 'X'.repeat(22_000) }
    });
    assert.equal(res.ok, true);
  }
  const asidePromptsBeforeUsage = (await aside.service.handleMessage({ type: 'getPrompts' })).prompts!;
  const bigPrompt0Id = Object.keys(asidePromptsBeforeUsage.prompts).find(
    (id) => asidePromptsBeforeUsage.prompts[id].title === 'Big Prompt 0'
  )!;
  await aside.service.handleMessage({ type: 'trackPromptUsage', id: bigPrompt0Id });
  await aside.service.handleMessage({ type: 'trackPromptUsage', id: bigPrompt0Id });

  const asideStatus = (await aside.service.handleMessage({ type: 'getSyncStatus' })).syncStatus!;
  assert.equal(asideStatus.state, 'synced');
  assert.ok((asideStatus.bytesUsed ?? 0) > 130_000, 'Drive payload should exceed 130 KB without truncation');

  // Chrome concurrently creates its own project BEFORE pulling Aside's data -> pre-push merge prevents clobbering
  clock.tick(100);
  await chrome.service.handleMessage({
    type: 'upsertProject',
    project: makeProject('p-chrome', 'Chrome Work', clock.now()),
    editing: false
  });

  const chromeState = (await chrome.service.handleMessage({ type: 'getState' })).state!;
  const chromePrompts = (await chrome.service.handleMessage({ type: 'getPrompts' })).prompts!;
  assert.deepEqual(chromeState.projects.map((p) => p.id).sort(), ['p-chrome', 'p-research']);
  assert.equal(chromeState.chatIndex['conv-42']?.lastUrl, 'https://gemini.google.com/u/2/app/conv-42');
  assert.equal(chromeState.chatIndex['local-only'], undefined, 'Unassigned chats must stay local');
  assert.equal(chromeState.uiPrefs.projectsCollapsed, false, 'uiPrefs must stay local');
  assert.equal(chromePrompts.prompts[bigPrompt0Id]?.usageCount, 0, 'Prompt usageCount must stay local');
  assert.equal(chromePrompts.prompts[bigPrompt0Id]?.lastUsedAt, 0, 'Prompt lastUsedAt must stay local');
  const bigPromptCount = Object.values(chromePrompts.prompts).filter((p) => p.title.startsWith('Big Prompt')).length;
  assert.equal(bigPromptCount, 6, 'All 6 >22KB prompts must sync completely via Google Drive');

  // Aside pulls Chrome's concurrent project and preserves its own local usageCount
  await aside.service.handleMessage({ type: 'syncNow' });
  const asideState = (await aside.service.handleMessage({ type: 'getState' })).state!;
  const asidePromptsAfterSync = (await aside.service.handleMessage({ type: 'getPrompts' })).prompts!;
  assert.deepEqual(asideState.projects.map((p) => p.id).sort(), ['p-chrome', 'p-research']);
  assert.equal(asidePromptsAfterSync.prompts[bigPrompt0Id]?.usageCount, 2, 'Local usageCount must be preserved across sync');

  // Debounced assigned chat metadata sync
  clock.tick(100);
  const updatesBeforeRename = server.updateCalls;
  await aside.service.handleMessage({
    type: 'upsertChatRefs',
    chats: [{ conversationId: 'conv-42', title: 'Renamed in Aside', lastUrl: 'https://gemini.google.com/u/2/app/conv-42' }]
  });
  assert.equal(server.updateCalls, updatesBeforeRename, 'upsertChatRefs must debounce Drive write');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(server.updateCalls, updatesBeforeRename + 1, 'Debounced Drive push must fire');

  await chrome.service.handleMessage({ type: 'syncNow' });
  const chromeAfterRename = (await chrome.service.handleMessage({ type: 'getState' })).state!;
  assert.equal(chromeAfterRename.chatIndex['conv-42']?.title, 'Renamed in Aside');

  aside.dispose();
  chrome.dispose();
});

// 4. Delete, unassign, re-assign recovery via tombstones & restoreBackup propagation
test('4. Delete, unassign, re-assign recovery, and restoreBackup propagate cleanly via Google Drive', async () => {
  const clock = createClock();
  const server = new MockGoogleDriveServer();
  const deviceA = createDriveDevice(server, clock);
  const deviceB = createDriveDevice(server, clock);

  await deviceA.service.handleMessage({ type: 'connectGoogleDrive' });
  await deviceB.service.handleMessage({ type: 'connectGoogleDrive' });

  await deviceA.service.handleMessage({ type: 'upsertProject', project: makeProject('p1', 'Alpha', clock.tick(10)), editing: false });
  await deviceA.service.handleMessage({ type: 'upsertProject', project: makeProject('p2', 'Beta', clock.tick(10)), editing: false });
  await deviceA.service.handleMessage({
    type: 'moveChat',
    conversationId: 'c1',
    projectId: 'p1',
    metadata: { conversationId: 'c1', title: 'Chat 1', lastUrl: 'https://gemini.google.com/app/c1' }
  });
  await deviceA.service.handleMessage({ type: 'savePrompt', prompt: { title: 'Temp Prompt', content: 'Body' } });
  await deviceB.service.handleMessage({ type: 'syncNow' });

  const promptsA = (await deviceA.service.handleMessage({ type: 'getPrompts' })).prompts!;
  const tempPromptId = Object.keys(promptsA.prompts).find((id) => promptsA.prompts[id].title === 'Temp Prompt')!;

  // Unassign c1, delete p2, delete tempPromptId on Device A
  clock.tick(100);
  await deviceA.service.handleMessage({ type: 'moveChat', conversationId: 'c1', projectId: null });
  await deviceA.service.handleMessage({ type: 'deleteProject', projectId: 'p2' });
  await deviceA.service.handleMessage({ type: 'deletePrompt', id: tempPromptId });

  await deviceB.service.handleMessage({ type: 'syncNow' });
  let stateB = (await deviceB.service.handleMessage({ type: 'getState' })).state!;
  let promptsB = (await deviceB.service.handleMessage({ type: 'getPrompts' })).prompts!;
  assert.deepEqual(stateB.projects.map((p) => p.id), ['p1']);
  assert.equal(stateB.chatIndex['c1']?.projectId, null);
  assert.equal(promptsB.prompts[tempPromptId], undefined);

  // Re-assign c1 on Device B -> overrides tombstone and propagates back to Device A
  clock.tick(100);
  await deviceB.service.handleMessage({ type: 'moveChat', conversationId: 'c1', projectId: 'p1' });
  await deviceA.service.handleMessage({ type: 'syncNow' });
  const stateA = (await deviceA.service.handleMessage({ type: 'getState' })).state!;
  assert.equal(stateA.chatIndex['c1']?.projectId, 'p1');

  // Restore backup on Device A -> propagates restored state & tombstones to Device B
  const backupPayload = {
    version: 1,
    exportedAt: new Date(clock.now()).toISOString(),
    projects: {
      schemaVersion: 1,
      projects: [makeProject('p1', 'Restored Alpha', 1000)],
      chatIndex: {},
      uiPrefs: { projectsCollapsed: false }
    },
    prompts: {
      version: 1,
      prompts: {
        'pr-restored': {
          id: 'pr-restored',
          title: 'Restored Prompt',
          content: 'Restored Content',
          createdAt: 1000,
          updatedAt: 1000,
          usageCount: 0,
          lastUsedAt: 0
        }
      }
    }
  };
  const restoreRes = await deviceA.service.handleMessage({ type: 'restoreBackup', data: backupPayload });
  assert.equal(restoreRes.ok, true);

  await deviceB.service.handleMessage({ type: 'syncNow' });
  stateB = (await deviceB.service.handleMessage({ type: 'getState' })).state!;
  promptsB = (await deviceB.service.handleMessage({ type: 'getPrompts' })).prompts!;
  assert.deepEqual(stateB.projects.map((p) => [p.id, p.name]), [['p1', 'Restored Alpha']]);
  assert.equal(stateB.chatIndex['c1']?.projectId, null);
  assert.deepEqual(Object.keys(promptsB.prompts), ['pr-restored']);

  deviceA.dispose();
  deviceB.dispose();
});

// 5. Duplicate gemini-projects-sync-v1.json self-healing & cached file 404 fallback
test('5. Duplicate gemini-projects-sync-v1.json files self-heal into oldest file and cached file 404 falls back cleanly', async () => {
  const clock = createClock();
  const server = new MockGoogleDriveServer();

  const snap1 = {
    projects: [makeProject('p-oldest', 'From File 1', clock.now())],
    chats: [],
    prompts: [{ id: 'pr-1', title: 'Prompt 1', content: 'Body 1', createdAt: clock.now(), updatedAt: clock.now() }],
    tombstones: createEmptyTombstones()
  };
  const snap2 = {
    projects: [makeProject('p-dup', 'From File 2', clock.tick(50))],
    chats: [],
    prompts: [{ id: 'pr-2', title: 'Prompt 2', content: 'Body 2', createdAt: clock.now(), updatedAt: clock.now() }],
    tombstones: createEmptyTombstones()
  };

  const file1 = server.seedFile(
    JSON.stringify({ v: 1, clientId: 'c1', rev: 1, updatedAt: clock.now(), hash: computeSnapshotHash(snap1), snapshot: snap1 }),
    1000
  );
  const file2 = server.seedFile(
    JSON.stringify({ v: 1, clientId: 'c2', rev: 1, updatedAt: clock.now(), hash: computeSnapshotHash(snap2), snapshot: snap2 }),
    2000
  );

  const device = createDriveDevice(server, clock);
  const res = await device.service.handleMessage({ type: 'connectGoogleDrive' });
  assert.equal(res.ok, true);
  assert.equal(server.files.length, 1, 'Duplicate Drive file must be deleted after merging');
  assert.equal(server.files[0].id, file1.id, 'Oldest/primary Drive file must be kept');
  assert.notEqual(server.files[0].id, file2.id);

  const state = (await device.service.handleMessage({ type: 'getState' })).state!;
  const prompts = (await device.service.handleMessage({ type: 'getPrompts' })).prompts!;
  assert.deepEqual(state.projects.map((p) => p.id).sort(), ['p-dup', 'p-oldest']);
  assert.deepEqual(Object.keys(prompts.prompts).sort(), ['pr-1', 'pr-2']);

  // Verify driveFileId was cached; simulate external deletion (404) and verify push recovers by recreating file
  const localMeta = device.local.data[SYNC_LOCAL_META_KEY] as SyncLocalMeta;
  assert.equal(localMeta.driveFileId, file1.id);
  server.files = [];

  clock.tick(100);
  const pushRes = await device.service.handleMessage({
    type: 'upsertProject',
    project: makeProject('p-after-404', 'Recovered', clock.now()),
    editing: false
  });
  assert.equal(pushRes.ok, true);
  assert.equal(server.files.length, 1, 'Push after 404 must fall back to listing and recreate Drive file');
  const status = (await device.service.handleMessage({ type: 'getSyncStatus' })).syncStatus!;
  assert.equal(status.state, 'synced');

  device.dispose();
});

// 6. Token expiry & HTTP 401 silent renewal, auth_expired without unsolicited popup, interactive reconnect recovery
test('6. Token expiry & HTTP 401 silent renewal, auth_expired without unsolicited popup, and interactive reconnect recovery', async () => {
  const clock = createClock();
  const server = new MockGoogleDriveServer();
  const device = createDriveDevice(server, clock);
  device.identity.tokenLifetimeSec = 300; // 5 minutes

  assert.equal((await device.service.handleMessage({ type: 'connectGoogleDrive' })).ok, true);
  assert.equal(device.identity.interactiveCalls, 1);
  assert.equal(device.identity.silentCalls, 0);

  // 6a. Token expiring within 120s triggers silent renewal transparently (no interactive popup)
  clock.tick(200_000); // 100s remaining (< 120s buffer)
  await device.service.handleMessage({
    type: 'upsertProject',
    project: makeProject('p-renew', 'After Pre-Expiry Renewal', clock.now()),
    editing: false
  });
  assert.equal(device.identity.interactiveCalls, 1, 'Must never open interactive popup on pre-expiry renewal');
  assert.equal(device.identity.silentCalls, 1, 'Should silently renew expiring token');
  assert.equal((await device.service.handleMessage({ type: 'getSyncStatus' })).syncStatus?.state, 'synced');

  // 6b. HTTP 401 on valid-looking cached token -> clears token, silently renews once, retries request once
  server.revokeAllTokens();
  clock.tick(1000);
  await device.service.handleMessage({
    type: 'upsertProject',
    project: makeProject('p-401-ok', 'Recovered From 401', clock.now()),
    editing: false
  });
  assert.equal(device.identity.interactiveCalls, 1, 'Must never open interactive popup on 401 retry');
  assert.equal(device.identity.silentCalls, 2, 'Should retry once with silent renewal after HTTP 401');
  assert.equal((await device.service.handleMessage({ type: 'getSyncStatus' })).syncStatus?.state, 'synced');

  // 6c. HTTP 401 when silent renewal fails -> sets auth_expired without popup; local write still succeeds
  server.revokeAllTokens();
  device.identity.nextSilentBehavior = 'interaction_required';
  clock.tick(1000);
  const localWriteRes = await device.service.handleMessage({
    type: 'upsertProject',
    project: makeProject('p-offline-expired', 'Saved Locally While Expired', clock.now()),
    editing: false
  });
  assert.equal(localWriteRes.ok, true, 'Local mutation must succeed even when Drive auth expires');
  assert.equal(device.identity.interactiveCalls, 1, 'Must NEVER open unsolicited interactive OAuth window');
  const expiredStatus = (await device.service.handleMessage({ type: 'getSyncStatus' })).syncStatus!;
  assert.equal(expiredStatus.state, 'auth_expired');
  assert.equal(expiredStatus.lastError, DRIVE_SESSION_EXPIRED_MESSAGE);

  // 6d. Explicit reconnect (connectGoogleDrive) runs interactive OAuth and pushes pending local edit
  device.identity.nextSilentBehavior = 'ok';
  const reconnectRes = await device.service.handleMessage({ type: 'connectGoogleDrive' });
  assert.equal(reconnectRes.ok, true);
  assert.equal(reconnectRes.syncStatus?.state, 'synced');
  assert.equal(device.identity.interactiveCalls, 2, 'Explicit reconnect should launch interactive OAuth');
  assert.ok(server.files[0].content.includes('p-offline-expired'), 'Pending local edit must upload after reconnect');

  device.dispose();
});

// 7. Disconnect (clears token, pauses sync without deleting local/Drive data), reconnect union merge,
//    and legacy provider local meta migration
test('7. Disconnect pauses sync safely, reconnect union-merges edits, and legacy provider metadata migrates cleanly', async () => {
  const clock = createClock();
  const server = new MockGoogleDriveServer();
  const deviceA = createDriveDevice(server, clock);
  const deviceB = createDriveDevice(server, clock);

  assert.equal((await deviceA.service.handleMessage({ type: 'connectGoogleDrive' })).ok, true);
  assert.equal((await deviceB.service.handleMessage({ type: 'connectGoogleDrive' })).ok, true);

  await deviceA.service.handleMessage({
    type: 'upsertProject',
    project: makeProject('p-shared', 'Shared', clock.tick(10)),
    editing: false
  });

  // Disconnect Device A -> clears token, sets enabled=false, keeps local & Drive data intact
  const discRes = await deviceA.service.handleMessage({ type: 'disconnectGoogleDrive' });
  assert.equal(discRes.ok, true);
  assert.equal(discRes.syncStatus?.enabled, false);
  assert.equal(discRes.syncStatus?.state, 'disabled');
  assert.equal(deviceA.local.data[DRIVE_AUTH_STORAGE_KEY], undefined, 'Drive auth token must be cleared on disconnect');
  assert.equal(server.files.length, 1, 'Disconnect must NOT delete Google Drive file');
  const stateAfterDisc = (await deviceA.service.handleMessage({ type: 'getState' })).state!;
  assert.deepEqual(stateAfterDisc.projects.map((p) => p.id), ['p-shared'], 'Disconnect must NOT delete local data');

  // Local edits on Device A while disconnected make 0 Drive calls
  const reqsBeforeOfflineEdit = server.totalRequests;
  await deviceA.service.handleMessage({
    type: 'upsertProject',
    project: makeProject('p-while-disconnected', 'Offline Local Edit', clock.tick(50)),
    editing: false
  });
  assert.equal(server.totalRequests, reqsBeforeOfflineEdit, 'Disconnected edits must make 0 Drive calls');

  // Device B makes an edit to Drive while Device A is disconnected
  await deviceB.service.handleMessage({
    type: 'upsertProject',
    project: makeProject('p-from-b', 'Remote B Edit', clock.tick(50)),
    editing: false
  });

  // Reconnect Device A -> union-merges both local offline edit and Device B's remote edit
  const reconRes = await deviceA.service.handleMessage({ type: 'connectGoogleDrive' });
  assert.equal(reconRes.ok, true);
  assert.equal(reconRes.syncStatus?.enabled, true);
  assert.equal(reconRes.syncStatus?.state, 'synced');
  const mergedStateA = (await deviceA.service.handleMessage({ type: 'getState' })).state!;
  assert.deepEqual(
    mergedStateA.projects.map((p) => p.id).sort(),
    ['p-from-b', 'p-shared', 'p-while-disconnected']
  );

  // Legacy local metadata migration: provider='google_drive' -> enabled=true preserving Drive metadata
  const migratedDrive = sanitizeLocalMeta(
    {
      provider: 'google_drive',
      enabled: false,
      clientId: 'legacy-drive-client',
      driveFileId: 'drive_file_legacy_1',
      driveLastModifiedTime: '2026-11-27T01:02:03.000Z',
      lastSyncedRev: 99,
      lastSyncedHash: 'browser-hash',
      lastSyncedAt: 1111,
      driveLastSyncedRev: 7,
      driveLastSyncedHash: 'deadbeef12345678',
      driveLastSyncedAt: 2222,
      tombstones: createEmptyTombstones(),
      status: { provider: 'google_drive', state: 'synced', bytesUsed: 4096 }
    },
    'fallback-client',
    true
  );
  assert.equal(migratedDrive.enabled, true);
  assert.equal(migratedDrive.driveFileId, 'drive_file_legacy_1');
  assert.equal(migratedDrive.driveLastModifiedTime, '2026-11-27T01:02:03.000Z');
  assert.equal(migratedDrive.lastSyncedRev, 7);
  assert.equal(migratedDrive.lastSyncedHash, 'deadbeef12345678');
  assert.equal(migratedDrive.lastSyncedAt, 2222);
  assert.equal(migratedDrive.status.state, 'synced');
  assert.equal(migratedDrive.status.bytesUsed, 4096);

  // Legacy local metadata migration: provider='browser' -> enabled=false, state='disabled'
  const migratedBrowser = sanitizeLocalMeta(
    {
      provider: 'browser',
      enabled: true,
      clientId: 'legacy-browser-client',
      lastSyncedRev: 12,
      lastSyncedHash: 'browser-hash-abc',
      lastSyncedAt: 3333,
      tombstones: createEmptyTombstones(),
      status: { provider: 'browser', state: 'synced', bytesUsed: 2048 }
    },
    'fallback-client',
    true
  );
  assert.equal(migratedBrowser.enabled, false);
  assert.equal(migratedBrowser.lastSyncedRev, 0);
  assert.equal(migratedBrowser.lastSyncedHash, '');
  assert.equal(migratedBrowser.lastSyncedAt, null);
  assert.equal(migratedBrowser.status.state, 'disabled');
  assert.equal(migratedBrowser.status.bytesUsed, undefined);

  // Also verify SW boot with legacy browser metadata stays local-only with 0 Drive calls
  const legacyLocal = new MockLocalStorage();
  legacyLocal.data[SYNC_LOCAL_META_KEY] = {
    provider: 'browser',
    enabled: true,
    clientId: 'legacy-sw',
    lastSyncedRev: 4,
    lastSyncedHash: 'abc12345',
    lastSyncedAt: 5000,
    tombstones: createEmptyTombstones(),
    status: { provider: 'browser', state: 'synced' }
  };
  const legacyDevice = createDriveDevice(server, clock, { local: legacyLocal });
  const reqsBeforeLegacyBoot = server.totalRequests;
  const legacyStatus = (await legacyDevice.service.handleMessage({ type: 'getSyncStatus' })).syncStatus!;
  assert.equal(legacyStatus.enabled, false);
  assert.equal(legacyStatus.state, 'disabled');
  assert.equal(server.totalRequests, reqsBeforeLegacyBoot);

  deviceA.dispose();
  deviceB.dispose();
  legacyDevice.dispose();
});

// 8. syncIfStale 15s throttling, unchanged modifiedTime skip, no auth_expired spam
test('8. syncIfStale throttles to 15s intervals, skips unchanged downloads, and does not spam auth_expired', async () => {
  const clock = createClock();
  const server = new MockGoogleDriveServer();
  const deviceA = createDriveDevice(server, clock);
  const deviceB = createDriveDevice(server, clock);

  await deviceA.service.handleMessage({ type: 'connectGoogleDrive' });
  await deviceB.service.handleMessage({ type: 'connectGoogleDrive' });

  // Immediately after sync, syncIfStale makes 0 requests
  const reqsAt0 = server.totalRequests;
  await deviceB.service.handleMessage({ type: 'syncIfStale' });
  clock.tick(14_000);
  await deviceB.service.handleMessage({ type: 'syncIfStale' });
  assert.equal(server.totalRequests, reqsAt0, 'syncIfStale must make 0 network requests within 15s');

  // After >= 15s with no remote changes, syncIfStale lists once and skips file download when modifiedTime matches
  await deviceB.service.handleMessage({ type: 'syncNow' }); // records server's modifiedTime
  clock.tick(16_000);
  const readsBeforeUnchanged = server.readCalls;
  await deviceB.service.handleMessage({ type: 'syncIfStale' });
  assert.equal(server.readCalls, readsBeforeUnchanged, 'Unchanged modifiedTime should skip downloading Drive body');

  // Device A edits a project -> after >= 15s, Device B's syncIfStale pulls the new project
  await deviceA.service.handleMessage({
    type: 'upsertProject',
    project: makeProject('p-from-focus', 'Pulled on Focus', clock.tick(100)),
    editing: false
  });
  clock.tick(16_000);
  await deviceB.service.handleMessage({ type: 'syncIfStale' });
  const stateB = (await deviceB.service.handleMessage({ type: 'getState' })).state!;
  assert.ok(stateB.projects.some((p) => p.id === 'p-from-focus'), 'syncIfStale should pull remote changes after 15s');

  // When auth_expired, syncIfStale must not spam silent OAuth calls
  server.revokeAllTokens();
  deviceB.identity.nextSilentBehavior = 'interaction_required';
  await deviceB.service.handleMessage({ type: 'syncNow' });
  assert.equal((await deviceB.service.handleMessage({ type: 'getSyncStatus' })).syncStatus?.state, 'auth_expired');
  const silentBeforeStale = deviceB.identity.silentCalls;
  clock.tick(60_000);
  await deviceB.service.handleMessage({ type: 'syncIfStale' });
  assert.equal(deviceB.identity.silentCalls, silentBeforeStale, 'syncIfStale must not retry silent auth while auth_expired');

  deviceA.dispose();
  deviceB.dispose();
});

// 9. Malformed / hostile Drive payloads rejected/sanitized without wiping local data
test('9. Malformed and hostile Google Drive payloads are sanitized or rejected without wiping local data', async () => {
  const clock = createClock();
  const server = new MockGoogleDriveServer();
  const now = clock.now();

  const hostileEnvelope = {
    v: 1,
    clientId: 'attacker',
    rev: 1,
    updatedAt: now,
    hash: 'deadbeef12345678',
    snapshot: {
      projects: [
        { id: '__proto__', name: 'Pollute', icon: 'coding', iconStyle: 'duotone', createdAt: now, updatedAt: now, sortIndex: 1 },
        { id: 'constructor', name: 'BadCtor', icon: 'coding', iconStyle: 'duotone', createdAt: now, updatedAt: now, sortIndex: 2 },
        { id: 'bad-color', name: 'Bad Color', icon: 'coding', iconStyle: 'duotone', color: 'red;url(javascript:1)', createdAt: now, updatedAt: now, sortIndex: 3 },
        { id: 'bad-style', name: 'Bad Style', icon: 'coding', iconStyle: '<script>', createdAt: now, updatedAt: now, sortIndex: 4 },
        { id: 'good-proj', name: 'Safe Drive Project', icon: 'unknown-xyz', iconStyle: 'solid', color: '#336699', createdAt: now, updatedAt: now, sortIndex: 5 }
      ],
      chats: [
        { id: '__proto__', projectId: 'good-proj', title: 'Bad ID', updatedAt: now },
        { id: 'evil-url', projectId: 'good-proj', title: 'Evil URL', lastUrl: 'javascript:alert(1)', updatedAt: now },
        { id: 'evil-host', projectId: 'good-proj', title: 'Evil Host', lastUrl: 'https://evil.example/app/evil-host', updatedAt: now },
        { id: 'good-chat', projectId: 'good-proj', title: 'Safe Chat', lastUrl: 'https://gemini.google.com/u/0/app/good-chat', updatedAt: now }
      ],
      prompts: [
        { id: '__proto__', title: 'Bad', content: 'Bad', createdAt: now, updatedAt: now },
        { id: 'empty-title', title: '   ', content: 'Body', createdAt: now, updatedAt: now },
        { id: 'good-prompt', title: 'Safe Prompt', content: 'Safe Body', createdAt: now, updatedAt: now }
      ],
      tombstones: {
        projects: { __proto__: now, 'valid-del': now },
        chats: 'corrupt',
        prompts: { constructor: now }
      }
    }
  };
  server.seedFile(JSON.stringify(hostileEnvelope), now);

  const device = createDriveDevice(server, clock);
  assert.equal((await device.service.handleMessage({ type: 'connectGoogleDrive' })).ok, true);

  const stateRes = await device.service.handleMessage({ type: 'getState' });
  const promptsRes = await device.service.handleMessage({ type: 'getPrompts' });
  assert.equal(({} as Record<string, unknown>).Pollute, undefined, 'Object.prototype must not be polluted');
  assert.deepEqual(stateRes.state?.projects.map((p) => p.id), ['good-proj']);
  assert.equal(stateRes.state?.projects[0].icon, 'default');
  assert.deepEqual(Object.keys(stateRes.state?.chatIndex ?? {}), ['good-chat']);
  assert.deepEqual(Object.keys(promptsRes.prompts?.prompts ?? {}), ['good-prompt']);

  // Completely corrupt JSON in Drive must report error without wiping local data
  server.files[0].content = '{corrupt-not-json!!!';
  const corruptRes = await device.service.handleMessage({ type: 'syncNow' });
  assert.equal(corruptRes.ok, false);
  assert.equal(corruptRes.syncStatus?.state, 'error');
  const afterCorrupt = (await device.service.handleMessage({ type: 'getState' })).state!;
  assert.deepEqual(afterCorrupt.projects.map((p) => p.id), ['good-proj'], 'Corrupt Drive file must never wipe local data');

  // Invalid envelope schema must also reject cleanly without wiping local data
  server.files[0].content = JSON.stringify({ v: 99, snapshot: null });
  const invalidSchemaRes = await device.service.handleMessage({ type: 'syncNow' });
  assert.equal(invalidSchemaRes.ok, false);
  assert.equal(invalidSchemaRes.syncStatus?.state, 'error');
  const afterInvalid = (await device.service.handleMessage({ type: 'getState' })).state!;
  assert.deepEqual(afterInvalid.projects.map((p) => p.id), ['good-proj'], 'Invalid schema must never wipe local data');

  // Also ensure STORAGE_KEY and PROMPTS_KEY remain persisted intact
  assert.ok(device.local.data[STORAGE_KEY]);
  assert.ok(device.local.data[PROMPTS_KEY]);

  device.dispose();
});

// 10. Real Drive fields=id,modifiedTime,version contract & same-millisecond version change detection
test('10. Real Drive fields=id,modifiedTime,version contract skips unchanged files and catches same-ms version updates', async () => {
  const clock = createClock();
  const server = new MockGoogleDriveServer();
  const deviceA = createDriveDevice(server, clock);
  const deviceB = createDriveDevice(server, clock);

  // createSyncFile must request and persist modifiedTime + version
  assert.equal((await deviceA.service.handleMessage({ type: 'connectGoogleDrive' })).ok, true);
  const metaAfterCreate = deviceA.local.data[SYNC_LOCAL_META_KEY] as SyncLocalMeta;
  assert.ok(metaAfterCreate.driveLastModifiedTime);
  assert.equal(metaAfterCreate.driveLastVersion, '1');

  // updateSyncFile must request and persist updated modifiedTime + version
  assert.equal(
    (
      await deviceA.service.handleMessage({
        type: 'upsertProject',
        project: makeProject('p-v2', 'Version 2', clock.tick(100)),
        editing: false
      })
    ).ok,
    true
  );
  const metaAfterUpdate = deviceA.local.data[SYNC_LOCAL_META_KEY] as SyncLocalMeta;
  assert.equal(metaAfterUpdate.driveLastModifiedTime, server.files[0].modifiedTime);
  assert.equal(metaAfterUpdate.driveLastVersion, '2');

  // Device B connects and syncs; subsequent syncIfStale skips download while modifiedTime + version match
  assert.equal((await deviceB.service.handleMessage({ type: 'connectGoogleDrive' })).ok, true);
  const metaB = deviceB.local.data[SYNC_LOCAL_META_KEY] as SyncLocalMeta;
  assert.equal(metaB.driveLastVersion, '2');

  clock.tick(16_000);
  const readsBeforeSkip = server.readCalls;
  await deviceB.service.handleMessage({ type: 'syncIfStale' });
  assert.equal(server.readCalls, readsBeforeSkip, 'Unchanged modifiedTime + version must skip downloading Drive body');

  // Remote updates file within the exact same millisecond (same modifiedTime, incremented version)
  const sameMs = server.files[0].modifiedTime;
  const remoteSnap = {
    projects: [
      projectToSync(makeProject('p-v2', 'Version 2', clock.now())),
      projectToSync(makeProject('p-same-ms', 'Same Millisecond Update', clock.tick(10)))
    ],
    chats: [],
    prompts: [],
    tombstones: createEmptyTombstones()
  };
  const remoteEnv: DriveSyncEnvelopeV1 = {
    v: 1,
    clientId: 'other-device',
    rev: 99,
    updatedAt: clock.now(),
    hash: computeSnapshotHash(remoteSnap),
    snapshot: remoteSnap
  };
  server.files[0].content = JSON.stringify(remoteEnv);
  server.files[0].modifiedTime = sameMs;
  server.files[0].version += 1;

  clock.tick(16_000);
  await deviceB.service.handleMessage({ type: 'syncIfStale' });
  assert.equal(server.readCalls, readsBeforeSkip + 1, 'Incremented Drive version with identical modifiedTime must trigger download');
  const stateB = (await deviceB.service.handleMessage({ type: 'getState' })).state!;
  assert.ok(stateB.projects.some((p) => p.id === 'p-same-ms'));
  assert.equal((deviceB.local.data[SYNC_LOCAL_META_KEY] as SyncLocalMeta).driveLastVersion, '3');

  deviceA.dispose();
  deviceB.dispose();
});

// 11. Network resilience: timeouts, 1x retry on transient 503/429 (not POST), offline silent auth -> error + backoff + bypassBackoff
test('11. Network resilience: request timeouts, 1x transient retries, and offline silent-auth backoff/recovery', async () => {
  const clock = createClock();
  const server = new MockGoogleDriveServer();
  const device = createDriveDevice(server, clock, {
    requestTimeoutMs: 30,
    uploadTimeoutMs: 30,
    retryDelayMs: 0
  });
  device.identity.tokenLifetimeSec = 300;

  assert.equal((await device.service.handleMessage({ type: 'connectGoogleDrive' })).ok, true);

  // 11a. Fetch timeout aborts cleanly without hanging local writes
  server.failNextRequests.push({ delayMs: 150 }, { delayMs: 150 });
  const timeoutWriteRes = await device.service.handleMessage({
    type: 'upsertProject',
    project: makeProject('p-timeout', 'Saved Locally On Timeout', clock.tick(100)),
    editing: false
  });
  assert.equal(timeoutWriteRes.ok, true, 'Local write must complete without hanging on Drive timeout');
  assert.ok(timeoutWriteRes.state?.projects.some((p) => p.id === 'p-timeout'));
  const timeoutStatus = (await device.service.handleMessage({ type: 'getSyncStatus' })).syncStatus!;
  assert.equal(timeoutStatus.state, 'error');
  assert.match(timeoutStatus.lastError ?? '', /timed out/i);

  // 11b. Transient HTTP 503 & 429 retry once and succeed; POST createSyncFile does NOT retry
  server.failNextRequests.push({ status: 503 });
  const retry503Res = await device.service.handleMessage({ type: 'syncIfStale', bypassBackoff: true });
  assert.equal(retry503Res.ok, true);
  assert.equal(retry503Res.syncStatus?.state, 'synced');

  server.failNextRequests.push({ status: 429, retryAfter: '0' });
  const retry429Res = await device.service.handleMessage({ type: 'syncIfStale', bypassBackoff: true });
  assert.equal(retry429Res.ok, true);
  assert.equal(retry429Res.syncStatus?.state, 'synced');

  const postOnlyLocal = new MockLocalStorage();
  const postClient = new GoogleDriveSyncClient({
    local: postOnlyLocal,
    identity: device.identity,
    fetchImpl: server.fetchImpl,
    now: clock.now,
    requestTimeoutMs: 30,
    uploadTimeoutMs: 30,
    retryDelayMs: 0
  });
  await postOnlyLocal.set({
    [DRIVE_AUTH_STORAGE_KEY]: { accessToken: 'tok_post_check', expiresAt: clock.now() + 3_600_000 }
  });
  server.validTokens.add('tok_post_check');
  const reqsBeforePost503 = server.totalRequests;
  server.failNextRequests.push({ status: 503 });
  await assert.rejects(
    () => postClient.createSyncFile('{}'),
    (err: unknown) => err instanceof DriveApiError && err.status === 503
  );
  assert.equal(server.totalRequests, reqsBeforePost503 + 1, 'POST createSyncFile must NOT retry on 503');

  // 11c. Offline silent-renewal failure -> recoverable error (not auth_expired), exponential backoff 15s -> 30s -> 60s, immediate recovery on bypassBackoff
  clock.tick(200_000); // token enters 120s expiry buffer -> triggers silent auth
  device.identity.nextSilentBehavior = 'fail';
  const silentBeforeOffline = device.identity.silentCalls;
  const offlineRes1 = await device.service.handleMessage({ type: 'syncIfStale' });
  assert.equal(offlineRes1.ok, false);
  assert.equal(offlineRes1.syncStatus?.state, 'error', 'Offline silent auth failure must NOT transition to auth_expired');
  assert.ok(device.local.data[DRIVE_AUTH_STORAGE_KEY], 'Cached token must be kept on transient network error');
  assert.equal(device.identity.silentCalls, silentBeforeOffline + 1);

  // Within 30s backoff (at +16s), syncIfStale is throttled
  clock.tick(16_000);
  await device.service.handleMessage({ type: 'syncIfStale' });
  assert.equal(device.identity.silentCalls, silentBeforeOffline + 1, '1st error must back off to 30s');

  // At +32s (>= 30s), syncIfStale runs and fails -> backoff doubles to 60s
  clock.tick(16_000);
  const offlineRes2 = await device.service.handleMessage({ type: 'syncIfStale' });
  assert.equal(offlineRes2.ok, false);
  assert.equal(offlineRes2.syncStatus?.state, 'error');
  assert.equal(device.identity.silentCalls, silentBeforeOffline + 2);

  // Within 60s backoff (at +32s), syncIfStale is throttled
  clock.tick(32_000);
  await device.service.handleMessage({ type: 'syncIfStale' });
  assert.equal(device.identity.silentCalls, silentBeforeOffline + 2, '2nd error must back off to 60s');

  // Network returns -> bypassBackoff: true runs immediately without waiting 60s
  device.identity.nextSilentBehavior = 'ok';
  const recoveredRes = await device.service.handleMessage({ type: 'syncIfStale', bypassBackoff: true });
  assert.equal(recoveredRes.ok, true);
  assert.equal(recoveredRes.syncStatus?.state, 'synced');
  assert.equal(device.identity.silentCalls, silentBeforeOffline + 3);

  device.dispose();
});

// 12. SW cold restart with slow Drive: getState returns local immediately while background init still pulls remote
test('12. SW cold restart with slow Drive returns local state immediately and reconciles in background', async () => {
  const clock = createClock();
  const server = new MockGoogleDriveServer();
  const deviceA = createDriveDevice(server, clock);
  const deviceB = createDriveDevice(server, clock);

  assert.equal((await deviceA.service.handleMessage({ type: 'connectGoogleDrive' })).ok, true);
  assert.equal(
    (
      await deviceA.service.handleMessage({
        type: 'upsertProject',
        project: makeProject('p-local-existing', 'Existing Local', clock.tick(50)),
        editing: false
      })
    ).ok,
    true
  );

  // Device B pushes a newer project while Device A is offline/before restart
  assert.equal((await deviceB.service.handleMessage({ type: 'connectGoogleDrive' })).ok, true);
  assert.equal(
    (
      await deviceB.service.handleMessage({
        type: 'upsertProject',
        project: makeProject('p-remote-new', 'Remote After Restart', clock.tick(50)),
        editing: false
      })
    ).ok,
    true
  );

  deviceA.restartSw();
  server.failNextRequests.push({ delayMs: 80 });

  // getState must resolve immediately with local data without waiting 80ms for slow Drive
  const fastResult = await Promise.race([
    deviceA.service.handleMessage({ type: 'getState' }),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 25))
  ]);
  assert.ok(fastResult !== null && fastResult.ok, 'getState must return immediately when local data exists');
  assert.deepEqual(fastResult.state?.projects.map((p) => p.id), ['p-local-existing']);

  // Once slow Drive responds, background init reconcile pulls p-remote-new
  await new Promise((resolve) => setTimeout(resolve, 120));
  const afterBgState = (await deviceA.service.handleMessage({ type: 'getState' })).state!;
  assert.deepEqual(
    afterBgState.projects.map((p) => p.id).sort(),
    ['p-local-existing', 'p-remote-new']
  );

  deviceA.dispose();
  deviceB.dispose();
});

// 13. Clock skew & backwards clock jump: backwards jump does not freeze syncIfStale, and slow-clock rename wins monotonically
test('13. Backwards clock jump does not freeze syncIfStale and slow-clock chat rename bumps updatedAt monotonically', async () => {
  const clockFast = createClock(1_700_000_060_000);
  const clockSlow = createClock(1_700_000_000_000);
  const server = new MockGoogleDriveServer();
  const deviceFast = createDriveDevice(server, clockFast, { debounceMs: 15 });
  const deviceSlow = createDriveDevice(server, clockSlow, { debounceMs: 15 });

  assert.equal((await deviceFast.service.handleMessage({ type: 'connectGoogleDrive' })).ok, true);
  assert.equal((await deviceSlow.service.handleMessage({ type: 'connectGoogleDrive' })).ok, true);

  // 13a. Backwards clock jump on deviceSlow must not freeze syncIfStale
  assert.equal(
    (
      await deviceFast.service.handleMessage({
        type: 'upsertProject',
        project: makeProject('p-skew', 'Skew Project', clockFast.tick(10)),
        editing: false
      })
    ).ok,
    true
  );
  await deviceSlow.service.handleMessage({ type: 'syncNow' });

  assert.equal(
    (
      await deviceFast.service.handleMessage({
        type: 'upsertProject',
        project: makeProject('p-after-clock-back', 'After Backwards Jump', clockFast.tick(10)),
        editing: false
      })
    ).ok,
    true
  );
  clockSlow.tick(-3_600_000); // system clock jumps backwards by 1 hour
  await deviceSlow.service.handleMessage({ type: 'syncIfStale' });
  const slowStateAfterJump = (await deviceSlow.service.handleMessage({ type: 'getState' })).state!;
  assert.ok(
    slowStateAfterJump.projects.some((p) => p.id === 'p-after-clock-back'),
    'Backwards clock jump must not freeze syncIfStale'
  );

  // 13b. Fast-clock device assigns a chat; slow-clock device renames it via upsertChatRefs -> rename wins monotonically
  const fastChatMove = await deviceFast.service.handleMessage({
    type: 'moveChat',
    conversationId: 'chat-skew',
    projectId: 'p-skew',
    metadata: {
      conversationId: 'chat-skew',
      title: 'Old Fast Title',
      lastUrl: 'https://gemini.google.com/app/chat-skew'
    }
  });
  const fastUpdatedAt = fastChatMove.state!.chatIndex['chat-skew'].updatedAt;

  await deviceSlow.service.handleMessage({ type: 'syncNow' });
  const slowRename = await deviceSlow.service.handleMessage({
    type: 'upsertChatRefs',
    chats: [
      {
        conversationId: 'chat-skew',
        title: 'Renamed On Slow Clock',
        lastUrl: 'https://gemini.google.com/app/chat-skew'
      }
    ]
  });
  assert.ok(
    slowRename.state!.chatIndex['chat-skew'].updatedAt > fastUpdatedAt,
    'Assigned chat rename must bump updatedAt monotonically above fast-clock timestamp'
  );

  // Wait for debounced push from deviceSlow, then pull on deviceFast
  await new Promise((resolve) => setTimeout(resolve, 40));
  await deviceFast.service.handleMessage({ type: 'syncNow' });
  const fastFinalState = (await deviceFast.service.handleMessage({ type: 'getState' })).state!;
  assert.equal(fastFinalState.chatIndex['chat-skew'].title, 'Renamed On Slow Clock');

  deviceFast.dispose();
  deviceSlow.dispose();
});

// 14. Local-only OAuth login_hint for reliable multi-account silent renewal
test('14. Local-only OAuth login_hint supports multi-account silent renewal without leaking email into Drive sync file', async () => {
  const clock = createClock();
  const server = new MockGoogleDriveServer();
  const device = createDriveDevice(server, clock);
  device.identity.tokenLifetimeSec = 300;

  // 14a. Interactive connect does NOT send login_hint, fetches /drive/v3/about,
  //      persists loginHint in gp_drive_auth_v1, and never writes email into Drive JSON file
  const connectRes = await device.service.handleMessage({ type: 'connectGoogleDrive' });
  assert.equal(connectRes.ok, true);
  assert.equal(device.identity.lastAuthUrl?.searchParams.get('login_hint'), null, 'Interactive OAuth must not force login_hint');
  assert.equal(server.aboutCalls, 1);

  const cachedAfterConnect = device.local.data[DRIVE_AUTH_STORAGE_KEY] as DriveAuthToken;
  assert.equal(cachedAfterConnect.loginHint, 'sync-owner@example.com');
  assert.equal(server.files.length, 1);
  assert.equal(
    server.files[0].content.includes('sync-owner@example.com'),
    false,
    'Account email must stay local-only and never be written into Drive sync JSON'
  );

  // 14b. Pre-expiry silent renewal passes login_hint + prompt=none, verifies account via /about, and preserves loginHint
  clock.tick(200_000); // 100s remaining (< 120s buffer)
  const preExpiryWrite = await device.service.handleMessage({
    type: 'upsertProject',
    project: makeProject('p-hint-pre', 'Pre-Expiry Hint Renewal', clock.now()),
    editing: false
  });
  assert.equal(preExpiryWrite.ok, true);
  assert.equal(device.identity.silentCalls, 1);
  assert.equal(device.identity.lastAuthUrl?.searchParams.get('prompt'), 'none');
  assert.equal(device.identity.lastAuthUrl?.searchParams.get('login_hint'), 'sync-owner@example.com');
  assert.equal((device.local.data[DRIVE_AUTH_STORAGE_KEY] as DriveAuthToken).loginHint, 'sync-owner@example.com');
  assert.equal(server.aboutCalls, 2, 'Silent renewal must verify token ownership via /about');

  // 14c. HTTP 401 silent renewal passes login_hint + prompt=none, verifies account via /about, and preserves loginHint
  server.revokeAllTokens();
  clock.tick(1000);
  const retry401Write = await device.service.handleMessage({
    type: 'upsertProject',
    project: makeProject('p-hint-401', '401 Hint Renewal', clock.now()),
    editing: false
  });
  assert.equal(retry401Write.ok, true);
  assert.equal(device.identity.silentCalls, 2);
  assert.equal(device.identity.lastAuthUrl?.searchParams.get('prompt'), 'none');
  assert.equal(device.identity.lastAuthUrl?.searchParams.get('login_hint'), 'sync-owner@example.com');
  assert.equal((device.local.data[DRIVE_AUTH_STORAGE_KEY] as DriveAuthToken).loginHint, 'sync-owner@example.com');
  assert.equal(server.aboutCalls, 3);

  // 14d. Legacy cached token without loginHint refuses silent renewal with auth_expired
  const cachedWithoutHint = device.local.data[DRIVE_AUTH_STORAGE_KEY] as DriveAuthToken;
  await device.local.set({
    [DRIVE_AUTH_STORAGE_KEY]: {
      accessToken: cachedWithoutHint.accessToken,
      expiresAt: cachedWithoutHint.expiresAt
    }
  });
  server.revokeAllTokens();
  clock.tick(1000);
  const legacyUnboundRes = await device.service.handleMessage({ type: 'syncNow' });
  assert.equal(legacyUnboundRes.ok, false);
  assert.equal(legacyUnboundRes.syncStatus?.state, 'auth_expired');
  assert.equal(device.identity.silentCalls, 2, 'Unbound legacy token must not attempt silent renewal');
  assert.equal(device.local.data[DRIVE_AUTH_STORAGE_KEY], undefined);

  // Reconnect interactively to continue testing disconnect, /about 500, and account mismatch
  assert.equal((await device.service.handleMessage({ type: 'connectGoogleDrive' })).ok, true);

  // 14e. disconnectGoogleDrive clears gp_drive_auth_v1 including loginHint
  const discRes = await device.service.handleMessage({ type: 'disconnectGoogleDrive' });
  assert.equal(discRes.ok, true);
  assert.equal(device.local.data[DRIVE_AUTH_STORAGE_KEY], undefined);

  // 14f. If /drive/v3/about returns 500 during connect, connectGoogleDrive succeeds without loginHint,
  //      and subsequent silent renewal rejects with auth_expired rather than syncing to an unverified account
  server.failNextRequests.push({ status: 500 });
  const aboutFailConnect = await device.service.handleMessage({ type: 'connectGoogleDrive' });
  assert.equal(aboutFailConnect.ok, true);
  assert.equal(aboutFailConnect.syncStatus?.state, 'synced');
  const cachedAfterAboutFail = device.local.data[DRIVE_AUTH_STORAGE_KEY] as DriveAuthToken;
  assert.ok(cachedAfterAboutFail.accessToken);
  assert.equal(cachedAfterAboutFail.loginHint, undefined);

  clock.tick(200_000); // token enters expiry buffer -> needs silent renewal without bound loginHint
  const silentBeforeUnbound = device.identity.silentCalls;
  await device.service.handleMessage({
    type: 'upsertProject',
    project: makeProject('p-unbound-blocked', 'Should Not Sync Unbound', clock.now()),
    editing: false
  });
  assert.equal(device.identity.silentCalls, silentBeforeUnbound, 'Unbound token must refuse silent renewal');
  assert.equal((await device.service.handleMessage({ type: 'getSyncStatus' })).syncStatus?.state, 'auth_expired');
  assert.equal(
    server.files[0].content.includes('p-unbound-blocked'),
    false,
    'Unbound account must not upload local data via silent renewal'
  );

  // 14g. If silent renewal returns a token for a DIFFERENT email, reject with auth_expired and do NOT upload
  assert.equal((await device.service.handleMessage({ type: 'connectGoogleDrive' })).ok, true);
  server.accountEmail = 'other-account@example.com';
  clock.tick(200_000); // token enters expiry buffer -> triggers silent renewal
  await device.service.handleMessage({
    type: 'upsertProject',
    project: makeProject('p-mismatch-blocked', 'Should Not Leak To Other Account', clock.now()),
    editing: false
  });
  const mismatchStatus = (await device.service.handleMessage({ type: 'getSyncStatus' })).syncStatus!;
  assert.equal(mismatchStatus.state, 'auth_expired');
  assert.equal(device.local.data[DRIVE_AUTH_STORAGE_KEY], undefined, 'Mismatched token must be cleared');
  assert.equal(
    server.files[0].content.includes('p-mismatch-blocked'),
    false,
    'Local data must NOT be uploaded to a mismatched Google account'
  );

  device.dispose();
});

// 15. Atomic restoreBackup, remote-aware tombstones, offline push warning, and stale-hash merge protection
test('15. Atomic restoreBackup, remote-aware tombstones, offline push warning, and stale-hash merge protection', async () => {
  const clock = createClock();
  const server = new MockGoogleDriveServer();

  // 15a. Atomic restoreBackup: quota error on local.set leaves zero orphan tombstones and preserves original projects on later connect
  const seedDevice = createDriveDevice(server, clock);
  assert.equal((await seedDevice.service.handleMessage({ type: 'connectGoogleDrive' })).ok, true);
  assert.equal(
    (
      await seedDevice.service.handleMessage({
        type: 'upsertProject',
        project: makeProject('p-orig', 'Original Project', clock.tick(10)),
        editing: false
      })
    ).ok,
    true
  );

  const deviceA = createDriveDevice(server, clock);
  await deviceA.service.handleMessage({
    type: 'upsertProject',
    project: makeProject('p-orig', 'Original Project', clock.now()),
    editing: false
  });

  const origSet = deviceA.local.set.bind(deviceA.local);
  let failOnce = true;
  deviceA.local.set = async (items) => {
    if (failOnce && Object.hasOwn(items, STORAGE_KEY)) {
      failOnce = false;
      throw new Error('QuotaExceededError');
    }
    return origSet(items);
  };

  await assert.rejects(
    () =>
      deviceA.service.handleMessage({
        type: 'restoreBackup',
        data: {
          version: 1,
          exportedAt: new Date(clock.now()).toISOString(),
          projects: {
            schemaVersion: CURRENT_SCHEMA_VERSION,
            projects: [makeProject('p-other', 'Other Project', 1000)],
            chatIndex: {},
            uiPrefs: { projectsCollapsed: false }
          }
        }
      }),
    /QuotaExceededError/
  );

  const metaAfterFail = deviceA.local.data[SYNC_LOCAL_META_KEY] as SyncLocalMeta | undefined;
  assert.equal(
    metaAfterFail?.tombstones.projects['p-orig'],
    undefined,
    'Failed restoreBackup must NOT persist orphan tombstones'
  );
  const stateAfterFail = (await deviceA.service.handleMessage({ type: 'getState' })).state!;
  assert.deepEqual(stateAfterFail.projects.map((p) => p.id), ['p-orig']);

  const connectAfterFail = await deviceA.service.handleMessage({ type: 'connectGoogleDrive' });
  assert.equal(connectAfterFail.ok, true);
  const stateAfterConnect = (await deviceA.service.handleMessage({ type: 'getState' })).state!;
  assert.ok(
    stateAfterConnect.projects.some((p) => p.id === 'p-orig'),
    'Later connecting Google Drive must NOT delete original projects'
  );

  // 15b. Connected restoreBackup tombstones unpulled remote projects created by Device B so they do NOT come back
  const deviceB = createDriveDevice(server, clock);
  assert.equal((await deviceB.service.handleMessage({ type: 'connectGoogleDrive' })).ok, true);
  clock.tick(50);
  assert.equal(
    (
      await deviceB.service.handleMessage({
        type: 'upsertProject',
        project: makeProject('p-unpulled-b', 'Unpulled Remote B', clock.now()),
        editing: false
      })
    ).ok,
    true
  );

  clock.tick(50);
  const restoreRemoteAware = await deviceA.service.handleMessage({
    type: 'restoreBackup',
    data: {
      version: 1,
      exportedAt: new Date(clock.now()).toISOString(),
      projects: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        projects: [makeProject('p-orig', 'Original Project Restored', 1000)],
        chatIndex: {},
        uiPrefs: { projectsCollapsed: false }
      },
      prompts: { version: 1, prompts: {} }
    }
  });
  assert.equal(restoreRemoteAware.ok, true);
  assert.equal(restoreRemoteAware.warning, undefined);
  const metaAfterRestore = deviceA.local.data[SYNC_LOCAL_META_KEY] as SyncLocalMeta;
  assert.ok(
    (metaAfterRestore.tombstones.projects['p-unpulled-b'] ?? 0) > 0,
    'Unpulled remote project must be tombstoned on restoreBackup'
  );

  await deviceB.service.handleMessage({ type: 'syncNow' });
  const stateBAfterRestore = (await deviceB.service.handleMessage({ type: 'getState' })).state!;
  assert.deepEqual(stateBAfterRestore.projects.map((p) => p.id), ['p-orig']);

  await deviceA.service.handleMessage({ type: 'syncNow' });
  const stateAAfterSync = (await deviceA.service.handleMessage({ type: 'getState' })).state!;
  assert.deepEqual(stateAAfterSync.projects.map((p) => p.id), ['p-orig']);

  // 15c. Connected restoreBackup when Drive push fails offline returns { ok: true, warning: ... }
  const offlineDevice = createDriveDevice(server, clock, { retryDelayMs: 0 });
  assert.equal((await offlineDevice.service.handleMessage({ type: 'connectGoogleDrive' })).ok, true);
  server.failNextRequests.push(
    { throwError: new Error('Network offline') },
    { throwError: new Error('Network offline') },
    { throwError: new Error('Network offline') },
    { throwError: new Error('Network offline') }
  );
  const offlineRestoreRes = await offlineDevice.service.handleMessage({
    type: 'restoreBackup',
    data: {
      version: 1,
      exportedAt: new Date(clock.now()).toISOString(),
      projects: {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        projects: [makeProject('p-offline-restored', 'Offline Restored', 1000)],
        chatIndex: {},
        uiPrefs: { projectsCollapsed: false }
      }
    }
  });
  assert.equal(offlineRestoreRes.ok, true);
  assert.ok(
    typeof offlineRestoreRes.warning === 'string' && offlineRestoreRes.warning.length > 0,
    'Offline Drive push failure during restoreBackup must return a warning'
  );
  assert.equal(offlineRestoreRes.syncStatus?.state, 'error');
  const offlineLocalState = (await offlineDevice.service.handleMessage({ type: 'getState' })).state!;
  assert.deepEqual(offlineLocalState.projects.map((p) => p.id), ['p-offline-restored']);

  // 15d. Stale/mismatched hash in remote Drive envelope does NOT cause tryFastDrivePush to skip merge
  const staleMeta = deviceA.local.data[SYNC_LOCAL_META_KEY] as SyncLocalMeta;
  const currentRemoteEnv = JSON.parse(server.files[0].content) as DriveSyncEnvelopeV1;
  const tamperedRemoteEnv: DriveSyncEnvelopeV1 = {
    ...currentRemoteEnv,
    clientId: 'other-device',
    rev: currentRemoteEnv.rev + 1,
    hash: staleMeta.lastSyncedHash, // intentionally stale hash matching deviceA.lastSyncedHash
    snapshot: {
      ...currentRemoteEnv.snapshot,
      projects: [
        ...currentRemoteEnv.snapshot.projects,
        projectToSync(makeProject('p-remote-stale-hash', 'Remote With Stale Hash', clock.tick(10)))
      ]
    }
  };
  server.files[0].content = JSON.stringify(tamperedRemoteEnv);

  const pushAfterStaleHash = await deviceA.service.handleMessage({
    type: 'upsertProject',
    project: makeProject('p-local-after-stale', 'Local After Stale', clock.tick(10)),
    editing: false
  });
  assert.equal(pushAfterStaleHash.ok, true);
  const mergedAfterStale = (await deviceA.service.handleMessage({ type: 'getState' })).state!;
  assert.deepEqual(
    mergedAfterStale.projects.map((p) => p.id).sort(),
    ['p-local-after-stale', 'p-orig', 'p-remote-stale-hash']
  );

  seedDevice.dispose();
  deviceA.dispose();
  deviceB.dispose();
  offlineDevice.dispose();
});

// 16. Default seed prompt deduplication across multi-device local-first init, edits/deletes, and legacy random-UUID duplicates
test('16. Default seed prompts: deterministic IDs prevent multi-device duplicates, preserve edits/deletes, and self-heal legacy UUID duplicates', async () => {
  // 16a. Multi-device open-before-connect (3 devices)
  const clock = createClock();
  const server = new MockGoogleDriveServer();

  const deviceA = createDriveDevice(server, clock);
  const deviceB = createDriveDevice(server, clock);
  const deviceC = createDriveDevice(server, clock);

  const expectedSeedIds = ['seed-bug-fix', 'seed-code-review', 'seed-email-polish', 'seed-summarize'];

  const localA = (await deviceA.service.handleMessage({ type: 'getPrompts' })).prompts!;
  const localB = (await deviceB.service.handleMessage({ type: 'getPrompts' })).prompts!;
  const localC = (await deviceC.service.handleMessage({ type: 'getPrompts' })).prompts!;
  assert.deepEqual(Object.keys(localA.prompts).sort(), expectedSeedIds);
  assert.deepEqual(Object.keys(localB.prompts).sort(), expectedSeedIds);
  assert.deepEqual(Object.keys(localC.prompts).sort(), expectedSeedIds);

  assert.equal((await deviceA.service.handleMessage({ type: 'connectGoogleDrive' })).ok, true);
  clock.tick(10);
  assert.equal((await deviceB.service.handleMessage({ type: 'connectGoogleDrive' })).ok, true);
  clock.tick(10);
  assert.equal((await deviceC.service.handleMessage({ type: 'connectGoogleDrive' })).ok, true);
  clock.tick(10);
  assert.equal((await deviceA.service.handleMessage({ type: 'syncNow' })).ok, true);
  assert.equal((await deviceB.service.handleMessage({ type: 'syncNow' })).ok, true);

  for (const device of [deviceA, deviceB, deviceC]) {
    const prompts = (await device.service.handleMessage({ type: 'getPrompts' })).prompts!;
    assert.deepEqual(Object.keys(prompts.prompts).sort(), expectedSeedIds);
    assert.equal(Object.keys(prompts.prompts).length, 4);
  }

  // 16b. Edited & deleted seed preservation when a brand new device runs locally before connecting
  clock.tick(100);
  const editedTitle = 'Summarize (Edited)';
  const editedContent = 'Custom summary prompt body';
  assert.equal(
    (
      await deviceA.service.handleMessage({
        type: 'savePrompt',
        prompt: { id: 'seed-summarize', title: editedTitle, content: editedContent }
      })
    ).ok,
    true
  );
  clock.tick(10);
  assert.equal(
    (await deviceA.service.handleMessage({ type: 'deletePrompt', id: 'seed-email-polish' })).ok,
    true
  );

  const deviceD = createDriveDevice(server, clock);
  const localD = (await deviceD.service.handleMessage({ type: 'getPrompts' })).prompts!;
  assert.deepEqual(Object.keys(localD.prompts).sort(), expectedSeedIds);

  clock.tick(10);
  assert.equal((await deviceD.service.handleMessage({ type: 'connectGoogleDrive' })).ok, true);
  const mergedD = (await deviceD.service.handleMessage({ type: 'getPrompts' })).prompts!;
  assert.deepEqual(Object.keys(mergedD.prompts).sort(), ['seed-bug-fix', 'seed-code-review', 'seed-summarize']);
  assert.equal(mergedD.prompts['seed-summarize'].title, editedTitle);
  assert.equal(mergedD.prompts['seed-summarize'].content, editedContent);
  assert.equal(mergedD.prompts['seed-email-polish'], undefined, 'Deleted seed must NOT be resurrected');

  assert.equal((await deviceA.service.handleMessage({ type: 'syncNow' })).ok, true);
  const mergedA = (await deviceA.service.handleMessage({ type: 'getPrompts' })).prompts!;
  assert.deepEqual(Object.keys(mergedA.prompts).sort(), ['seed-bug-fix', 'seed-code-review', 'seed-summarize']);
  assert.equal(mergedA.prompts['seed-summarize'].title, editedTitle);
  assert.equal(mergedA.prompts['seed-email-polish'], undefined);

  deviceA.dispose();
  deviceB.dispose();
  deviceC.dispose();
  deviceD.dispose();

  // 16c. Legacy random-UUID duplicate self-healing (3 copies of 4 unmodified seeds + 2 custom = 14 -> 6)
  const legacyClock = createClock();
  const legacyServer = new MockGoogleDriveServer();
  const baseTs = legacyClock.now();
  const baseSeeds = Object.values(createSeedData().prompts);
  const legacyPrompts: SyncPrompt[] = [];
  const expectedSurvivorIds: string[] = [];
  const expectedDupIds: string[] = [];

  for (let i = 0; i < baseSeeds.length; i += 1) {
    const seed = baseSeeds[i];
    const id1 = `11111111-0000-4000-8000-0000000000${i}a`;
    const id2 = `22222222-0000-4000-8000-0000000000${i}b`;
    const id3 = `33333333-0000-4000-8000-0000000000${i}c`;
    legacyPrompts.push(
      { id: id1, title: seed.title, content: seed.content, createdAt: baseTs - 300, updatedAt: baseTs - 300 },
      { id: id2, title: seed.title, content: seed.content, createdAt: baseTs - 200, updatedAt: baseTs - 200 },
      { id: id3, title: seed.title, content: seed.content, createdAt: baseTs - 100, updatedAt: baseTs - 100 }
    );
    expectedSurvivorIds.push(id1);
    expectedDupIds.push(id2, id3);
  }
  legacyPrompts.push(
    { id: 'custom-1', title: 'Custom One', content: 'User body 1', createdAt: baseTs - 50, updatedAt: baseTs - 50 },
    { id: 'custom-2', title: 'Custom Two', content: 'User body 2', createdAt: baseTs - 40, updatedAt: baseTs - 40 }
  );
  assert.equal(legacyPrompts.length, 14);

  const legacySnapshot: SyncSnapshot = {
    projects: [],
    chats: [],
    prompts: legacyPrompts,
    tombstones: createEmptyTombstones()
  };
  const legacyEnvelope: DriveSyncEnvelopeV1 = {
    v: 1,
    clientId: 'legacy-client',
    rev: 1,
    updatedAt: baseTs,
    hash: computeSnapshotHash(legacySnapshot),
    snapshot: legacySnapshot
  };
  legacyServer.seedFile(JSON.stringify(legacyEnvelope), baseTs);

  const deviceE = createDriveDevice(legacyServer, legacyClock);
  const deviceF = createDriveDevice(legacyServer, legacyClock);
  // Pre-seed deviceF locally with all 14 legacy prompts (and usage stats on duplicates) as if synced prior to upgrading
  await deviceF.local.set({
    [PROMPTS_KEY]: {
      version: 1,
      prompts: Object.fromEntries(
        legacyPrompts.map((p) => [
          p.id,
          { ...p, usageCount: p.id.endsWith('b') ? 3 : 0, lastUsedAt: p.id.endsWith('c') ? 999 : 0 }
        ])
      )
    }
  });

  legacyClock.tick(100);
  assert.equal((await deviceF.service.handleMessage({ type: 'connectGoogleDrive' })).ok, true);

  const promptsF = (await deviceF.service.handleMessage({ type: 'getPrompts' })).prompts!;
  const expectedFinalIds = [...expectedSurvivorIds, 'custom-1', 'custom-2'].sort();
  assert.deepEqual(Object.keys(promptsF.prompts).sort(), expectedFinalIds);
  assert.equal(Object.keys(promptsF.prompts).length, 6);
  assert.equal(promptsF.prompts['custom-1'].content, 'User body 1');
  assert.equal(promptsF.prompts['custom-2'].content, 'User body 2');
  for (const survivorId of expectedSurvivorIds) {
    assert.equal(promptsF.prompts[survivorId].usageCount, 3, 'Usage count must be preserved across deduplicated seeds');
    assert.equal(promptsF.prompts[survivorId].lastUsedAt, 999, 'lastUsedAt must be preserved across deduplicated seeds');
  }

  const metaF = deviceF.local.data[SYNC_LOCAL_META_KEY] as SyncLocalMeta;
  for (const dupId of expectedDupIds) {
    assert.ok((metaF.tombstones.prompts[dupId] ?? 0) > 0, `Duplicate ${dupId} must be tombstoned`);
  }

  legacyClock.tick(50);
  assert.equal((await deviceE.service.handleMessage({ type: 'connectGoogleDrive' })).ok, true);
  const promptsE = (await deviceE.service.handleMessage({ type: 'getPrompts' })).prompts!;
  assert.deepEqual(Object.keys(promptsE.prompts).sort(), expectedFinalIds);
  assert.equal(Object.keys(promptsE.prompts).length, 6);

  // Verify Drive snapshot converged to 6 prompts and 8 tombstones
  const healedDriveEnv = JSON.parse(legacyServer.files[0].content) as DriveSyncEnvelopeV1;
  assert.equal(healedDriveEnv.snapshot.prompts.length, 6);
  assert.deepEqual(
    healedDriveEnv.snapshot.prompts.map((p) => p.id).sort(),
    expectedFinalIds
  );
  for (const dupId of expectedDupIds) {
    assert.ok((healedDriveEnv.snapshot.tombstones.prompts[dupId] ?? 0) > 0);
  }

  deviceE.dispose();
  deviceF.dispose();
});
