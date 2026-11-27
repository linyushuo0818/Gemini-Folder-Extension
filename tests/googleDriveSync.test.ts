import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundService, BackgroundService } from '../src/background/service';
import { StorageAreaLike } from '../src/background/cloudSync';
import {
  DRIVE_SESSION_EXPIRED_MESSAGE,
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
  SYNC_LOCAL_META_KEY,
  SYNC_META_KEY,
  SYNC_STALE_INTERVAL_MS,
  SyncLocalMeta
} from '../src/shared/sync';
import { CURRENT_SCHEMA_VERSION, STORAGE_KEY } from '../src/shared/storage';
import { PROMPTS_KEY, PromptsData } from '../src/shared/prompts';
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

class MockSimpleBrowserSync implements StorageAreaLike {
  public data: Record<string, unknown> = {};
  public setCalls = 0;
  public getCalls = 0;

  async get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>> {
    this.getCalls += 1;
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
    return clone(this.data);
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.setCalls += 1;
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
  content: string;
}

class MockGoogleDriveServer {
  public files: StoredDriveFile[] = [];
  public validTokens = new Set<string>();
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
      content
    };
    this.files.push(file);
    return file;
  }

  public revokeAllTokens(): void {
    this.validTokens.clear();
  }

  public fetchImpl: typeof fetch = async (input, init = {}) => {
    this.totalRequests += 1;
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

    // List files in appDataFolder
    if (method === 'GET' && url.pathname === '/drive/v3/files') {
      this.listCalls += 1;
      assert.equal(url.searchParams.get('spaces'), 'appDataFolder');
      const matching = [...this.files]
        .filter((f) => f.name === DRIVE_SYNC_FILENAME && f.parents.includes('appDataFolder'))
        .sort((a, b) => a.createdTime - b.createdTime)
        .map((f) => ({ id: f.id, modifiedTime: f.modifiedTime }));
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

    // Create file (multipart/related)
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
        content: mediaText
      };
      this.files.push(file);
      return new Response(JSON.stringify({ id: file.id }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Update file (PATCH uploadType=media)
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
      return new Response(JSON.stringify({ id: file.id, modifiedTime: file.modifiedTime }), {
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
  browserSync: MockSimpleBrowserSync | null;
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
    browserSync?: MockSimpleBrowserSync | null;
    extensionId?: string;
    debounceMs?: number;
    staleIntervalMs?: number;
  } = {}
): DriveTestDevice {
  const local = opts.local ?? new MockLocalStorage();
  const browserSync = opts.browserSync === undefined ? new MockSimpleBrowserSync() : opts.browserSync;
  const identity = new MockIdentityProvider(server, opts.extensionId);
  let service: BackgroundService;

  const boot = () => {
    const drive = new GoogleDriveSyncClient({
      local,
      identity,
      fetchImpl: server.fetchImpl,
      now: clock.now
    });
    service = createBackgroundService({
      local,
      sync: browserSync,
      drive,
      now: clock.now,
      debounceMs: opts.debounceMs ?? 30,
      staleIntervalMs: opts.staleIntervalMs ?? SYNC_STALE_INTERVAL_MS
    });
  };

  boot();

  return {
    local,
    browserSync,
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

// 1. Connect Google Drive (OAuth params, CSRF validation, cancel safety, union merge without duplicate seeds)
test('1. Connect Google Drive: OAuth CSRF validation, cancel preserves provider, and union merge avoids duplicate seed prompts', async () => {
  const clock = createClock();
  const server = new MockGoogleDriveServer();

  // Seed Drive with existing data from another browser
  const remoteSnapshot = {
    projects: [makeProject('p-drive', 'Drive Project', clock.now())],
    chats: [
      {
        id: 'chat-drive-1',
        projectId: 'p-drive',
        title: 'From Chrome',
        lastUrl: 'https://gemini.google.com/u/1/app/chat-drive-1',
        updatedAt: clock.now()
      }
    ],
    prompts: [
      {
        id: 'pr-drive-1',
        title: 'Drive Prompt',
        content: 'Reusable prompt body',
        createdAt: clock.now(),
        updatedAt: clock.now()
      }
    ],
    tombstones: createEmptyTombstones()
  };
  const seedEnvelope: DriveSyncEnvelopeV1 = {
    v: 1,
    clientId: 'seed-client',
    rev: 1,
    updatedAt: clock.now(),
    hash: computeSnapshotHash(remoteSnapshot),
    snapshot: remoteSnapshot
  };
  server.seedFile(JSON.stringify(seedEnvelope), clock.now());

  const device = createDriveDevice(server, clock);

  // 1a. Cancelled OAuth leaves provider on 'browser' and stores no token
  device.identity.nextInteractiveBehavior = 'cancel';
  const cancelRes = await device.service.handleMessage({ type: 'connectGoogleDrive' });
  assert.equal(cancelRes.ok, false);
  assert.equal(cancelRes.syncStatus?.provider, 'browser');
  assert.equal(device.local.data[DRIVE_AUTH_STORAGE_KEY], undefined);

  // 1b. CSRF state mismatch is rejected and leaves provider on 'browser'
  device.identity.nextInteractiveBehavior = 'bad_state';
  const badStateRes = await device.service.handleMessage({ type: 'connectGoogleDrive' });
  assert.equal(badStateRes.ok, false);
  assert.equal(badStateRes.syncStatus?.provider, 'browser');
  assert.equal(device.local.data[DRIVE_AUTH_STORAGE_KEY], undefined);

  // 1c. Successful interactive connect verifies OAuth URL parameters & pulls remote data without seed prompt duplication
  const connectRes = await device.service.handleMessage({ type: 'connectGoogleDrive' });
  assert.equal(connectRes.ok, true);
  assert.equal(connectRes.syncStatus?.provider, 'google_drive');
  assert.equal(connectRes.syncStatus?.state, 'synced');
  assert.equal(connectRes.syncStatus?.driveAvailable, true);
  assert.ok(device.local.data[DRIVE_AUTH_STORAGE_KEY], 'Token must be persisted under gp_drive_auth_v1');

  // Verify OAuth URL parameters
  const authUrl = device.identity.lastAuthUrl!;
  assert.equal(authUrl.searchParams.get('client_id'), GOOGLE_DRIVE_CLIENT_ID);
  assert.equal(authUrl.searchParams.get('scope'), GOOGLE_DRIVE_SCOPE);
  assert.equal(authUrl.searchParams.get('response_type'), 'token');
  assert.equal(authUrl.searchParams.get('include_granted_scopes'), 'true');
  assert.equal(authUrl.searchParams.get('prompt'), null, 'Interactive OAuth must not set prompt=none');
  assert.ok(authUrl.searchParams.get('state'));

  const state = (await device.service.handleMessage({ type: 'getState' })).state!;
  const prompts = (await device.service.handleMessage({ type: 'getPrompts' })).prompts!;
  assert.deepEqual(state.projects.map((p) => p.id), ['p-drive']);
  assert.equal(state.chatIndex['chat-drive-1']?.lastUrl, 'https://gemini.google.com/u/1/app/chat-drive-1');
  assert.deepEqual(Object.keys(prompts.prompts), ['pr-drive-1'], 'Fresh device must not generate duplicate seed prompts');

  // Verify auth token is never serialized into the Drive sync file
  assert.equal(server.files[0].content.includes('tok_'), false, 'OAuth token must never appear in sync payload');

  device.dispose();
});

// 2. Cross-browser multi-device sync (Aside <-> Chrome), >100KB prompts, concurrent LWW merge, debounced upsertChatRefs
test('2. Cross-browser sync: Aside <-> Chrome, large >100KB prompts, concurrent LWW merge, and debounced chat metadata sync', async () => {
  const clock = createClock();
  const server = new MockGoogleDriveServer();

  // Aside browser (dev ID, no Browser Sync available) <-> Chrome browser (CWS ID)
  const aside = createDriveDevice(server, clock, {
    browserSync: null,
    extensionId: 'kiifegldibkapobmpjmcnpgeiclofijl',
    debounceMs: 25
  });
  const chrome = createDriveDevice(server, clock, {
    extensionId: 'okjjhdoncledadkchbbbcddpopbbgbic',
    debounceMs: 25
  });

  assert.equal((await aside.service.handleMessage({ type: 'connectGoogleDrive' })).ok, true);
  assert.equal((await chrome.service.handleMessage({ type: 'connectGoogleDrive' })).ok, true);

  // Aside creates a project, assigns a /u/2/app/... chat, and saves large prompts totaling >120 KB
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
  // Unassigned local chat & UI pref stay local
  await aside.service.handleMessage({ type: 'updateUiPrefs', prefs: { projectsCollapsed: true } });
  await aside.service.handleMessage({
    type: 'upsertChatRefs',
    chats: [{ conversationId: 'local-only', title: 'Noise', lastUrl: 'https://gemini.google.com/app/local-only' }]
  });

  // Save 6 huge prompts (22 KB each => >132 KB total, far beyond Chrome storage.sync's 100 KB / 8 KB limits)
  for (let i = 0; i < 6; i += 1) {
    clock.tick(10);
    const res = await aside.service.handleMessage({
      type: 'savePrompt',
      prompt: { title: `Big Prompt ${i}`, content: `P${i}-` + 'X'.repeat(22_000) }
    });
    assert.equal(res.ok, true);
  }

  const asideStatus = (await aside.service.handleMessage({ type: 'getSyncStatus' })).syncStatus!;
  assert.equal(asideStatus.state, 'synced');
  assert.equal(asideStatus.omittedPrompts, undefined);
  assert.ok((asideStatus.bytesUsed ?? 0) > 130_000, 'Drive payload should exceed 130 KB without truncation');

  // Chrome concurrently creates its own project BEFORE pulling Aside's data -> pre-push merge prevents clobbering!
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
  const bigPromptCount = Object.values(chromePrompts.prompts).filter((p) => p.title.startsWith('Big Prompt')).length;
  assert.equal(bigPromptCount, 6, 'All 6 >22KB prompts must sync completely via Google Drive');

  // Aside pulls Chrome's concurrent project and updates assigned chat title via debounced upsertChatRefs
  await aside.service.handleMessage({ type: 'syncNow' });
  const asideState = (await aside.service.handleMessage({ type: 'getState' })).state!;
  assert.deepEqual(asideState.projects.map((p) => p.id).sort(), ['p-chrome', 'p-research']);

  clock.tick(100);
  const updatesBeforeRename = server.updateCalls;
  await aside.service.handleMessage({
    type: 'upsertChatRefs',
    chats: [{ conversationId: 'conv-42', title: 'Renamed in Aside', lastUrl: 'https://gemini.google.com/u/2/app/conv-42' }]
  });
  assert.equal(server.updateCalls, updatesBeforeRename, 'upsertChatRefs must debounce Drive write');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(server.updateCalls, updatesBeforeRename + 1, 'Debounced Drive push must fire even without Browser Sync');

  await chrome.service.handleMessage({ type: 'syncNow' });
  const chromeAfterRename = (await chrome.service.handleMessage({ type: 'getState' })).state!;
  assert.equal(chromeAfterRename.chatIndex['conv-42']?.title, 'Renamed in Aside');

  aside.dispose();
  chrome.dispose();
});

// 3. Delete & unassign propagation via tombstones + restoreBackup propagation via Drive
test('3. Delete, unassign, re-assign recovery, and restoreBackup propagate cleanly via Google Drive', async () => {
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

// 4. Duplicate file self-healing + cached driveFileId 404 fallback
test('4. Duplicate gemini-projects-sync-v1.json files self-heal into oldest file and cached file 404 falls back cleanly', async () => {
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

  // Verify driveFileId was cached; now simulate external deletion (404) and verify push recovers by recreating file
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

// 5. Token expiry & HTTP 401 handling (silent renewal succeeds; failure sets auth_expired without popup; reconnect recovers)
test('5. Token expiry & HTTP 401 silent renewal, auth_expired without unsolicited popup, and interactive reconnect recovery', async () => {
  const clock = createClock();
  const server = new MockGoogleDriveServer();
  const device = createDriveDevice(server, clock);
  device.identity.tokenLifetimeSec = 300; // 5 minutes

  assert.equal((await device.service.handleMessage({ type: 'connectGoogleDrive' })).ok, true);
  assert.equal(device.identity.interactiveCalls, 1);
  assert.equal(device.identity.silentCalls, 0);

  // 5a. Token expiring within 120s triggers silent renewal transparently (no interactive popup)
  clock.tick(200_000); // 100s remaining (< 120s buffer)
  await device.service.handleMessage({
    type: 'upsertProject',
    project: makeProject('p-renew', 'After Pre-Expiry Renewal', clock.now()),
    editing: false
  });
  assert.equal(device.identity.interactiveCalls, 1, 'Must never open interactive popup on pre-expiry renewal');
  assert.equal(device.identity.silentCalls, 1, 'Should silently renew expiring token');
  assert.equal((await device.service.handleMessage({ type: 'getSyncStatus' })).syncStatus?.state, 'synced');

  // 5b. HTTP 401 on valid-looking cached token -> clears token, silently renews once, retries request once
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

  // 5c. HTTP 401 when silent renewal fails -> sets auth_expired without popup; local write still succeeds!
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

  // 5d. Explicit reconnect (connectGoogleDrive) runs interactive OAuth and pushes pending local edit
  device.identity.nextSilentBehavior = 'ok';
  const reconnectRes = await device.service.handleMessage({ type: 'connectGoogleDrive' });
  assert.equal(reconnectRes.ok, true);
  assert.equal(reconnectRes.syncStatus?.state, 'synced');
  assert.equal(device.identity.interactiveCalls, 2, 'Explicit reconnect should launch interactive OAuth');
  assert.ok(server.files[0].content.includes('p-offline-expired'), 'Pending local edit must upload after reconnect');

  device.dispose();
});

// 6. Mutual exclusion with Browser Sync & disconnect restores prior Browser Sync preference
test('6. Mutual exclusion ignores storage.sync while Drive is active; disconnect clears token and restores Browser Sync preference', async () => {
  const clock = createClock();
  const server = new MockGoogleDriveServer();
  const browserSync = new MockSimpleBrowserSync();
  const device = createDriveDevice(server, clock, { browserSync });

  // Turn Browser Sync OFF first, then connect Google Drive
  await device.service.handleMessage({ type: 'setSyncEnabled', enabled: false });
  assert.equal((await device.service.handleMessage({ type: 'getSyncStatus' })).syncStatus?.state, 'disabled');

  assert.equal((await device.service.handleMessage({ type: 'connectGoogleDrive' })).ok, true);
  const browserSetsAfterConnect = browserSync.setCalls;

  // Local edit writes to Drive ONLY, never to chrome.storage.sync
  await device.service.handleMessage({
    type: 'upsertProject',
    project: makeProject('p-drive-only', 'Drive Only', clock.tick(10)),
    editing: false
  });
  assert.equal(browserSync.setCalls, browserSetsAfterConnect, 'Local edits must not write to storage.sync while on Drive');

  // Incoming storage.sync change event is ignored while on Google Drive
  browserSync.data[SYNC_META_KEY] = {
    v: 1,
    clientId: 'other-browser',
    rev: 99,
    updatedAt: clock.tick(100),
    hash: 'abcdef1234567890',
    shards: { projects: 1, chats: 0, prompts: 0, tombstones: 0 }
  };
  const browserGetsBeforeChange = browserSync.getCalls;
  await device.service.handleSyncChanged({
    [SYNC_META_KEY]: { oldValue: undefined, newValue: browserSync.data[SYNC_META_KEY] }
  });
  assert.equal(browserSync.getCalls, browserGetsBeforeChange, 'storage.sync events must be ignored while on Google Drive');

  // Disconnect Drive -> clears token, keeps local & Drive data, restores previous Browser Sync preference (disabled!)
  const discRes = await device.service.handleMessage({ type: 'disconnectGoogleDrive' });
  assert.equal(discRes.ok, true);
  assert.equal(discRes.syncStatus?.provider, 'browser');
  assert.equal(discRes.syncStatus?.enabled, false, 'Prior Browser Sync off preference must be preserved');
  assert.equal(discRes.syncStatus?.state, 'disabled');
  assert.equal(device.local.data[DRIVE_AUTH_STORAGE_KEY], undefined, 'Drive auth token must be cleared on disconnect');
  assert.equal(server.files.length, 1, 'Disconnect must NOT delete Google Drive file');
  const stateAfterDisc = (await device.service.handleMessage({ type: 'getState' })).state!;
  assert.deepEqual(stateAfterDisc.projects.map((p) => p.id), ['p-drive-only'], 'Disconnect must NOT delete local data');

  // Re-enable Browser Sync, connect Drive again, then disconnect -> automatically reconciles back with Browser Sync!
  await device.service.handleMessage({ type: 'setSyncEnabled', enabled: true });
  await device.service.handleMessage({ type: 'connectGoogleDrive' });
  const discEnabledRes = await device.service.handleMessage({ type: 'disconnectGoogleDrive' });
  assert.equal(discEnabledRes.ok, true);
  assert.equal(discEnabledRes.syncStatus?.provider, 'browser');
  assert.equal(discEnabledRes.syncStatus?.enabled, true);
  assert.equal(discEnabledRes.syncStatus?.state, 'synced');

  device.dispose();
});

// 7. syncIfStale 30s throttling behavior on tab focus
test('7. syncIfStale throttles to 30s intervals, skips unchanged downloads, and does not spam auth_expired', async () => {
  const clock = createClock();
  const server = new MockGoogleDriveServer();
  const deviceA = createDriveDevice(server, clock);
  const deviceB = createDriveDevice(server, clock);

  await deviceA.service.handleMessage({ type: 'connectGoogleDrive' });
  await deviceB.service.handleMessage({ type: 'connectGoogleDrive' });

  // Immediately after sync, syncIfStale makes 0 requests
  const reqsAt0 = server.totalRequests;
  await deviceB.service.handleMessage({ type: 'syncIfStale' });
  clock.tick(29_000);
  await deviceB.service.handleMessage({ type: 'syncIfStale' });
  assert.equal(server.totalRequests, reqsAt0, 'syncIfStale must make 0 network requests within 30s');

  // After >= 30s with no remote changes, syncIfStale lists once and skips file download when modifiedTime matches
  await deviceB.service.handleMessage({ type: 'syncNow' }); // records server's modifiedTime
  clock.tick(31_000);
  const readsBeforeUnchanged = server.readCalls;
  await deviceB.service.handleMessage({ type: 'syncIfStale' });
  assert.equal(server.readCalls, readsBeforeUnchanged, 'Unchanged modifiedTime should skip downloading Drive body');

  // Device A edits a project -> after >= 30s, Device B's syncIfStale pulls the new project!
  await deviceA.service.handleMessage({
    type: 'upsertProject',
    project: makeProject('p-from-focus', 'Pulled on Focus', clock.tick(100)),
    editing: false
  });
  clock.tick(31_000);
  await deviceB.service.handleMessage({ type: 'syncIfStale' });
  const stateB = (await deviceB.service.handleMessage({ type: 'getState' })).state!;
  assert.ok(stateB.projects.some((p) => p.id === 'p-from-focus'), 'syncIfStale should pull remote changes after 30s');

  // When auth_expired, syncIfStale must not spam silent OAuth calls
  server.revokeAllTokens();
  deviceB.identity.nextSilentBehavior = 'fail';
  await deviceB.service.handleMessage({ type: 'syncNow' });
  assert.equal((await deviceB.service.handleMessage({ type: 'getSyncStatus' })).syncStatus?.state, 'auth_expired');
  const silentBeforeStale = deviceB.identity.silentCalls;
  clock.tick(60_000);
  await deviceB.service.handleMessage({ type: 'syncIfStale' });
  assert.equal(deviceB.identity.silentCalls, silentBeforeStale, 'syncIfStale must not retry silent auth while auth_expired');

  deviceA.dispose();
  deviceB.dispose();
});

// 8. Malformed/hostile Drive JSON payload rejection & sanitization
test('8. Malformed and hostile Google Drive payloads are sanitized or rejected without wiping local data', async () => {
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

  device.dispose();
});
