import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackgroundService, BackgroundService } from '../src/background/service';
import { StorageAreaLike } from '../src/background/cloudSync';
import {
  createEmptyTombstones,
  mergeSyncData,
  SYNC_CHATS_PREFIX,
  SYNC_LOCAL_META_KEY,
  SYNC_META_KEY,
  SYNC_PREFIX,
  SYNC_PROJECTS_PREFIX,
  SYNC_PROMPTS_PREFIX,
  SYNC_TOMBSTONES_KEY,
  SyncLocalMeta,
  syncEntryByteSize
} from '../src/shared/sync';
import { CURRENT_SCHEMA_VERSION, STORAGE_KEY } from '../src/shared/storage';
import { PROMPTS_KEY, PromptsData } from '../src/shared/prompts';
import { Project, StoredState } from '../src/shared/types';

const CHROME_SYNC_QUOTA_BYTES = 102400;
const CHROME_SYNC_QUOTA_BYTES_PER_ITEM = 8192;
const CHROME_SYNC_MAX_ITEMS = 512;

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

type SyncChangeListener = (changes: Record<string, chrome.storage.StorageChange>) => void | Promise<void>;

class MockChromeSyncStorage {
  public data: Record<string, unknown> = {};
  public setCalls = 0;
  public removeCalls = 0;
  public getCalls = 0;
  public nextSetError: Error | null = null;
  public failSetOnceIfStaleKeysPresent = false;
  public autoDeliverChanges = true;
  private listeners = new Set<SyncChangeListener>();
  private pendingDeliveries: Promise<void>[] = [];

  public totalBytes(map: Record<string, unknown> = this.data): number {
    let total = 0;
    for (const [k, v] of Object.entries(map)) {
      total += syncEntryByteSize(k, v);
    }
    return total;
  }

  public addListener(listener: SyncChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public async flushDeliveries(): Promise<void> {
    while (this.pendingDeliveries.length > 0) {
      const batch = this.pendingDeliveries.splice(0, this.pendingDeliveries.length);
      await Promise.all(batch);
    }
  }

  public createAdapter(): StorageAreaLike {
    return {
      get: async (keys) => {
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
        const out: Record<string, unknown> = {};
        for (const [k, def] of Object.entries(keys)) {
          out[k] = Object.hasOwn(this.data, k) ? clone(this.data[k]) : clone(def);
        }
        return out;
      },
      set: async (items) => {
        this.setCalls += 1;
        if (this.nextSetError) {
          const err = this.nextSetError;
          this.nextSetError = null;
          throw err;
        }

        const nextData: Record<string, unknown> = { ...this.data };
        const changes: Record<string, chrome.storage.StorageChange> = {};

        for (const [k, v] of Object.entries(items)) {
          const cloned = clone(v);
          const itemBytes = syncEntryByteSize(k, cloned);
          if (itemBytes > CHROME_SYNC_QUOTA_BYTES_PER_ITEM) {
            throw new Error(`QUOTA_BYTES_PER_ITEM quota exceeded for key ${k} (${itemBytes} > ${CHROME_SYNC_QUOTA_BYTES_PER_ITEM})`);
          }
          changes[k] = { oldValue: clone(this.data[k]), newValue: cloned };
          nextData[k] = cloned;
        }

        if (this.failSetOnceIfStaleKeysPresent) {
          const newKeys = new Set(Object.keys(items));
          const hasStale = Object.keys(this.data).some((k) => k.startsWith(SYNC_PREFIX) && !newKeys.has(k));
          if (hasStale) {
            this.failSetOnceIfStaleKeysPresent = false;
            throw new Error('QUOTA_BYTES quota exceeded');
          }
        }

        if (Object.keys(nextData).length > CHROME_SYNC_MAX_ITEMS) {
          throw new Error(`MAX_ITEMS quota exceeded (${Object.keys(nextData).length} > ${CHROME_SYNC_MAX_ITEMS})`);
        }

        const nextTotal = this.totalBytes(nextData);
        if (nextTotal > CHROME_SYNC_QUOTA_BYTES) {
          throw new Error(`QUOTA_BYTES quota exceeded (${nextTotal} > ${CHROME_SYNC_QUOTA_BYTES})`);
        }

        this.data = nextData;
        if (this.autoDeliverChanges && Object.keys(changes).length > 0) {
          this.emitChanges(changes);
        }
      },
      remove: async (keys) => {
        this.removeCalls += 1;
        const list = Array.isArray(keys) ? keys : [keys];
        const changes: Record<string, chrome.storage.StorageChange> = {};
        for (const k of list) {
          if (Object.hasOwn(this.data, k)) {
            changes[k] = { oldValue: clone(this.data[k]), newValue: undefined };
            delete this.data[k];
          }
        }
        if (this.autoDeliverChanges && Object.keys(changes).length > 0) {
          this.emitChanges(changes);
        }
      }
    };
  }

  public emitChanges(changes: Record<string, chrome.storage.StorageChange>): void {
    for (const listener of [...this.listeners]) {
      const promise = Promise.resolve(listener(clone(changes)));
      this.pendingDeliveries.push(promise);
    }
  }
}

interface TestDevice {
  local: MockLocalStorage;
  service: BackgroundService;
  detach: () => void;
  restartSw: () => void;
}

function createClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    tick: (ms = 10) => {
      current += ms;
      return current;
    },
    set: (ts: number) => {
      current = ts;
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

function createDevice(
  cloud: MockChromeSyncStorage | null,
  clock: { now: () => number },
  opts: { local?: MockLocalStorage; debounceMs?: number } = {}
): TestDevice {
  const local = opts.local ?? new MockLocalStorage();
  let service: BackgroundService;
  let detach = () => {};

  const boot = () => {
    service = createBackgroundService({
      local,
      sync: cloud ? cloud.createAdapter() : null,
      now: clock.now,
      debounceMs: opts.debounceMs ?? 40
    });
    detach = cloud ? cloud.addListener((changes) => service.handleSyncChanged(changes)) : () => {};
  };

  boot();

  return {
    local,
    get service() {
      return service;
    },
    detach: () => {
      detach();
      service.dispose();
    },
    restartSw: () => {
      detach();
      service.dispose();
      boot();
    }
  };
}

// 1. Cold-start (local-only, remote-only with no seed prompt duplication, both-have-data union merge)
test('1. Cold-start: local-only push, remote-only pull without seed duplication, and both-have-data union merge', async () => {
  const clock = createClock();
  const cloud = new MockChromeSyncStorage();

  // 1a. Local-only device upgrades to sync -> pushes projects, assigned chats, and prompts
  const localA = new MockLocalStorage();
  const initialStateA: StoredState = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projects: [makeProject('proj-a', 'Alpha', clock.now())],
    chatIndex: {
      'chat-1': {
        conversationId: 'chat-1',
        title: 'Assigned Chat',
        projectId: 'proj-a',
        updatedAt: clock.now(),
        lastUrl: 'https://gemini.google.com/u/1/app/chat-1'
      },
      'chat-unassigned': {
        conversationId: 'chat-unassigned',
        title: 'Local Only Unassigned',
        projectId: null,
        updatedAt: clock.now(),
        lastUrl: 'https://gemini.google.com/app/chat-unassigned'
      }
    },
    uiPrefs: { projectsCollapsed: true }
  };
  const initialPromptsA: PromptsData = {
    version: 1,
    prompts: {
      'prompt-a': {
        id: 'prompt-a',
        title: 'My Prompt A',
        content: 'Prompt content A',
        createdAt: clock.now(),
        updatedAt: clock.now(),
        usageCount: 7,
        lastUsedAt: clock.now()
      }
    }
  };
  await localA.set({ [STORAGE_KEY]: initialStateA, [PROMPTS_KEY]: initialPromptsA });

  const deviceA = createDevice(cloud, clock, { local: localA });
  const resA = await deviceA.service.handleMessage({ type: 'getState' });
  assert.equal(resA.ok, true);
  assert.ok(cloud.data[SYNC_META_KEY], 'Local-only device should push sync metadata on cold-start');

  // 1b. Fresh Device B connects -> pulls remote prompts directly without createSeedData() duplicates
  const deviceB = createDevice(cloud, clock);
  const stateB = await deviceB.service.handleMessage({ type: 'getState' });
  const promptsB = await deviceB.service.handleMessage({ type: 'getPrompts' });
  assert.equal(stateB.ok, true);
  assert.equal(promptsB.ok, true);
  assert.equal(stateB.state?.projects.length, 1);
  assert.equal(stateB.state?.projects[0].id, 'proj-a');
  assert.equal(stateB.state?.chatIndex['chat-1']?.lastUrl, 'https://gemini.google.com/u/1/app/chat-1');
  assert.equal(stateB.state?.chatIndex['chat-unassigned'], undefined, 'Unassigned chat must not sync');
  assert.equal(stateB.state?.uiPrefs.projectsCollapsed, false, 'uiPrefs must remain local-only');
  assert.deepEqual(Object.keys(promptsB.prompts?.prompts ?? {}), ['prompt-a'], 'No duplicate seed prompts on fresh device');
  assert.equal(promptsB.prompts?.prompts['prompt-a'].usageCount, 0, 'usageCount must stay local-only');

  // 1c. Device C already has its own local data when connecting to populated remote -> union merge (no wiping)
  clock.tick(100);
  const localC = new MockLocalStorage();
  await localC.set({
    [STORAGE_KEY]: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      projects: [makeProject('proj-c', 'Charlie', clock.now())],
      chatIndex: {},
      uiPrefs: { projectsCollapsed: false }
    },
    [PROMPTS_KEY]: {
      version: 1,
      prompts: {
        'prompt-c': {
          id: 'prompt-c',
          title: 'My Prompt C',
          content: 'Prompt content C',
          createdAt: clock.now(),
          updatedAt: clock.now(),
          usageCount: 3,
          lastUsedAt: clock.now()
        }
      }
    }
  });
  const deviceC = createDevice(cloud, clock, { local: localC });
  const stateC = await deviceC.service.handleMessage({ type: 'getState' });
  const promptsC = await deviceC.service.handleMessage({ type: 'getPrompts' });
  await cloud.flushDeliveries();

  assert.deepEqual(stateC.state?.projects.map((p) => p.id).sort(), ['proj-a', 'proj-c']);
  assert.deepEqual(Object.keys(promptsC.prompts?.prompts ?? {}).sort(), ['prompt-a', 'prompt-c']);

  // Device A & B also receive Device C's union-merged data
  const updatedA = await deviceA.service.handleMessage({ type: 'getState' });
  assert.deepEqual(updatedA.state?.projects.map((p) => p.id).sort(), ['proj-a', 'proj-c']);

  deviceA.detach();
  deviceB.detach();
  deviceC.detach();
});

// 2. Multi-device concurrent edits + local-only preservation + upsertChatRefs debounce
test('2. Multi-device concurrent edits, commutative LWW tie-break, local-only preservation, and debounced assigned chat metadata sync', async () => {
  const clock = createClock();
  const cloud = new MockChromeSyncStorage();
  const deviceA = createDevice(cloud, clock, { debounceMs: 30 });
  const deviceB = createDevice(cloud, clock, { debounceMs: 30 });

  await deviceA.service.handleMessage({ type: 'upsertProject', project: makeProject('p1', 'Shared', clock.now()), editing: false });
  await deviceA.service.handleMessage({
    type: 'moveChat',
    conversationId: 'c1',
    projectId: 'p1',
    metadata: { conversationId: 'c1', title: 'Initial Title', lastUrl: 'https://gemini.google.com/app/c1' }
  });
  const savePrRes = await deviceA.service.handleMessage({ type: 'savePrompt', prompt: { title: 'P', content: 'Body' } });
  assert.equal(savePrRes.ok, true);
  await cloud.flushDeliveries();

  const promptsBeforeUsage = (await deviceB.service.handleMessage({ type: 'getPrompts' })).prompts!;
  const createdPromptId = Object.keys(promptsBeforeUsage.prompts).find(
    (id) => promptsBeforeUsage.prompts[id].title === 'P'
  );
  assert.ok(createdPromptId, 'Created prompt should sync to Device B');

  // Local-only actions on Device B must NEVER trigger sync writes
  const setsBeforeLocalOnly = cloud.setCalls;
  await deviceB.service.handleMessage({ type: 'updateUiPrefs', prefs: { projectsCollapsed: true } });
  await deviceB.service.handleMessage({ type: 'trackPromptUsage', id: createdPromptId });
  await deviceB.service.handleMessage({
    type: 'upsertChatRefs',
    chats: [{ conversationId: 'unassigned-1', title: 'Noise', lastUrl: 'https://gemini.google.com/app/unassigned-1' }]
  });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(cloud.setCalls, setsBeforeLocalOnly, 'Local-only updates must not write to storage.sync');

  // Verify deterministic commutative tie-breaker when timestamps are identical
  const tieTs = clock.tick(50);
  const stateLeft: StoredState = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projects: [makeProject('p-tie', 'Alpha', tieTs)],
    chatIndex: {},
    uiPrefs: { projectsCollapsed: false }
  };
  const stateRight: StoredState = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    projects: [makeProject('p-tie', 'Beta', tieTs)],
    chatIndex: {},
    uiPrefs: { projectsCollapsed: false }
  };
  const emptyPrompts: PromptsData = { version: 1, prompts: {} };
  const mergeLR = mergeSyncData(
    stateLeft,
    emptyPrompts,
    createEmptyTombstones(),
    { projects: [stateRight.projects[0]], chats: [], prompts: [], tombstones: createEmptyTombstones() },
    tieTs
  );
  const mergeRL = mergeSyncData(
    stateRight,
    emptyPrompts,
    createEmptyTombstones(),
    { projects: [stateLeft.projects[0]], chats: [], prompts: [], tombstones: createEmptyTombstones() },
    tieTs
  );
  assert.equal(mergeLR.state.projects[0].name, mergeRL.state.projects[0].name, 'Equal-timestamp tie-breaker must be commutative');

  // Concurrent edit where newer updatedAt wins
  clock.tick(100);
  await deviceB.service.handleMessage({
    type: 'upsertProject',
    project: makeProject('p1', 'Name-Winner', clock.now()),
    editing: true
  });
  await cloud.flushDeliveries();

  const finalA = (await deviceA.service.handleMessage({ type: 'getState' })).state!;
  const finalB = (await deviceB.service.handleMessage({ type: 'getState' })).state!;
  assert.equal(finalA.projects[0].name, 'Name-Winner');
  assert.equal(finalB.projects[0].name, 'Name-Winner');
  assert.equal(finalB.uiPrefs.projectsCollapsed, true, 'Local uiPrefs preserved after sync');
  assert.ok(finalB.chatIndex['unassigned-1'], 'Local unassigned chat preserved after sync');
  const promptsB = (await deviceB.service.handleMessage({ type: 'getPrompts' })).prompts!;
  assert.equal(promptsB.prompts[createdPromptId].usageCount, 1, 'Local prompt usageCount preserved after sync');

  // Assigned chat title update via upsertChatRefs triggers debounced sync
  clock.tick(100);
  const setsBeforeRename = cloud.setCalls;
  await deviceA.service.handleMessage({
    type: 'upsertChatRefs',
    chats: [{ conversationId: 'c1', title: 'Renamed Chat', lastUrl: 'https://gemini.google.com/u/2/app/c1' }]
  });
  assert.equal(cloud.setCalls, setsBeforeRename, 'upsertChatRefs should be debounced, not immediate');
  await new Promise((r) => setTimeout(r, 70));
  await cloud.flushDeliveries();
  assert.equal(cloud.setCalls, setsBeforeRename + 1, 'Debounced sync should fire once');

  const syncedB = (await deviceB.service.handleMessage({ type: 'getState' })).state!;
  assert.equal(syncedB.chatIndex['c1']?.title, 'Renamed Chat');
  assert.equal(syncedB.chatIndex['c1']?.lastUrl, 'https://gemini.google.com/u/2/app/c1');

  deviceA.detach();
  deviceB.detach();
});

// 3. Delete & unassign propagation via tombstones (no resurrection + re-assign recovery)
test('3. Delete & unassign propagate via tombstones without resurrection and support re-assign recovery', async () => {
  const clock = createClock();
  const cloud = new MockChromeSyncStorage();
  const deviceA = createDevice(cloud, clock);
  const deviceB = createDevice(cloud, clock);

  await deviceA.service.handleMessage({ type: 'upsertProject', project: makeProject('p1', 'Work', clock.now()), editing: false });
  await deviceA.service.handleMessage({ type: 'upsertProject', project: makeProject('p2', 'Personal', clock.now()), editing: false });
  await deviceA.service.handleMessage({
    type: 'moveChat',
    conversationId: 'c1',
    projectId: 'p1',
    metadata: { conversationId: 'c1', title: 'Chat 1', lastUrl: 'https://gemini.google.com/app/c1' }
  });
  await deviceA.service.handleMessage({
    type: 'moveChat',
    conversationId: 'c2',
    projectId: 'p2',
    metadata: { conversationId: 'c2', title: 'Chat 2', lastUrl: 'https://gemini.google.com/app/c2' }
  });
  const prCreateRes = await deviceA.service.handleMessage({ type: 'savePrompt', prompt: { title: 'Temp', content: 'Body' } });
  assert.equal(prCreateRes.ok, true);
  await cloud.flushDeliveries();
  const initialPromptsA = (await deviceA.service.handleMessage({ type: 'getPrompts' })).prompts!;
  const tempPromptId = Object.keys(initialPromptsA.prompts).find((id) => initialPromptsA.prompts[id].title === 'Temp');
  assert.ok(tempPromptId);

  // Unassign c1 on Device A -> propagates to Device B
  clock.tick(100);
  await deviceA.service.handleMessage({ type: 'moveChat', conversationId: 'c1', projectId: null });
  await cloud.flushDeliveries();
  let stateB = (await deviceB.service.handleMessage({ type: 'getState' })).state!;
  assert.equal(stateB.chatIndex['c1']?.projectId, null, 'c1 should be unassigned on Device B');
  assert.equal(stateB.chatIndex['c1']?.title, 'Chat 1', 'Chat metadata preserved after unassign');

  // Force sync on Device B -> must NOT resurrect c1
  await deviceB.service.handleMessage({ type: 'syncNow' });
  await cloud.flushDeliveries();
  stateB = (await deviceB.service.handleMessage({ type: 'getState' })).state!;
  assert.equal(stateB.chatIndex['c1']?.projectId, null, 'Unassigned chat must not resurrect');

  // Re-assign c1 on Device B -> newer updatedAt overrides tombstone and propagates back to Device A
  clock.tick(100);
  await deviceB.service.handleMessage({ type: 'moveChat', conversationId: 'c1', projectId: 'p2' });
  await cloud.flushDeliveries();
  const stateA = (await deviceA.service.handleMessage({ type: 'getState' })).state!;
  assert.equal(stateA.chatIndex['c1']?.projectId, 'p2', 'Re-assigned chat should propagate back');

  // Delete project p2 & prompt tempPromptId on Device A -> Device B removes p2, sets c1 & c2 projectId=null, deletes prompt
  clock.tick(100);
  await deviceA.service.handleMessage({ type: 'deleteProject', projectId: 'p2' });
  await deviceA.service.handleMessage({ type: 'deletePrompt', id: tempPromptId });
  await cloud.flushDeliveries();

  stateB = (await deviceB.service.handleMessage({ type: 'getState' })).state!;
  const promptsB = (await deviceB.service.handleMessage({ type: 'getPrompts' })).prompts!;
  assert.deepEqual(stateB.projects.map((p) => p.id), ['p1']);
  assert.equal(stateB.chatIndex['c1']?.projectId, null);
  assert.equal(stateB.chatIndex['c2']?.projectId, null);
  assert.equal(promptsB.prompts[tempPromptId], undefined);

  deviceA.detach();
  deviceB.detach();
});

// 4. Sharding across multiple shards & stale shard key removal + retry-once on quota error
test('4. Multi-shard packing, stale shard cleanup, and quota retry-once when stale keys exist', async () => {
  const clock = createClock();
  const cloud = new MockChromeSyncStorage();
  const localA = new MockLocalStorage();

  // Pre-seed 160 assigned chats (~180B each => ~29KB => multiple chat shards under 7KB each)
  const project = makeProject('p-big', 'Big Project', clock.now());
  const chatIndex: StoredState['chatIndex'] = {};
  for (let i = 0; i < 160; i += 1) {
    const id = `chat-${String(i).padStart(3, '0')}`;
    chatIndex[id] = {
      conversationId: id,
      title: `Long conversation title number ${i} ${'x'.repeat(80)}`,
      projectId: 'p-big',
      updatedAt: clock.now() + i,
      lastUrl: `https://gemini.google.com/app/${id}`
    };
  }
  await localA.set({
    [STORAGE_KEY]: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      projects: [project],
      chatIndex,
      uiPrefs: { projectsCollapsed: false }
    },
    [PROMPTS_KEY]: { version: 1, prompts: {} }
  });

  const deviceA = createDevice(cloud, clock, { local: localA });
  await deviceA.service.handleMessage({ type: 'getState' });

  const chatShardKeys = Object.keys(cloud.data).filter((k) => k.startsWith(SYNC_CHATS_PREFIX)).sort();
  assert.ok(chatShardKeys.length >= 3, `Expected >= 3 chat shards, got ${chatShardKeys.length}`);
  for (const [k, v] of Object.entries(cloud.data)) {
    assert.ok(syncEntryByteSize(k, v) <= 7000, `Shard ${k} must stay <= 7000 bytes`);
  }

  // Device B reconstructs all 160 chats across shards
  const deviceB = createDevice(cloud, clock);
  const stateB = (await deviceB.service.handleMessage({ type: 'getState' })).state!;
  assert.equal(Object.keys(stateB.chatIndex).length, 160);

  // Now delete the project (shrinking chat shards to 0) AND simulate quota error on first set() with stale keys
  clock.tick(1000);
  cloud.failSetOnceIfStaleKeysPresent = true;
  await deviceA.service.handleMessage({ type: 'deleteProject', projectId: 'p-big' });
  await cloud.flushDeliveries();

  const remainingChatShards = Object.keys(cloud.data).filter((k) => k.startsWith(SYNC_CHATS_PREFIX));
  assert.equal(remainingChatShards.length, 0, 'Stale chat shard keys must be removed');
  const statusA = (await deviceA.service.handleMessage({ type: 'getSyncStatus' })).syncStatus!;
  assert.equal(statusA.state, 'synced', 'Retry-once after stale cleanup should succeed');

  deviceA.detach();
  deviceB.detach();
});

// 5. Quota exceeded / partial sync graceful degradation & oversized single prompt skip
test('5. Partial sync degradation, oversized single prompt skip, and Chrome QUOTA_BYTES handling without losing local data', async () => {
  const clock = createClock();
  const cloud = new MockChromeSyncStorage();
  const localA = new MockLocalStorage();

  // 5a. Oversized single prompt (> 7,000 B) + normal prompt
  await localA.set({
    [STORAGE_KEY]: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      projects: [makeProject('p1', 'Main', clock.now())],
      chatIndex: {},
      uiPrefs: { projectsCollapsed: false }
    },
    [PROMPTS_KEY]: {
      version: 1,
      prompts: {
        'huge-prompt': {
          id: 'huge-prompt',
          title: 'Huge Prompt',
          content: 'A'.repeat(7500),
          createdAt: clock.now(),
          updatedAt: clock.now() + 10,
          usageCount: 0,
          lastUsedAt: 0
        },
        'normal-prompt': {
          id: 'normal-prompt',
          title: 'Normal Prompt',
          content: 'Short body',
          createdAt: clock.now(),
          updatedAt: clock.now(),
          usageCount: 0,
          lastUsedAt: 0
        }
      }
    }
  });

  const deviceA = createDevice(cloud, clock, { local: localA });
  await deviceA.service.handleMessage({ type: 'getState' });

  let statusA = (await deviceA.service.handleMessage({ type: 'getSyncStatus' })).syncStatus!;
  assert.equal(statusA.state, 'partial');
  assert.equal(statusA.omittedPrompts, 1);

  // Device B gets normal prompt, does NOT get huge prompt; Device B edits & pushes -> Device A MUST keep huge-prompt!
  const deviceB = createDevice(cloud, clock);
  const promptsB = (await deviceB.service.handleMessage({ type: 'getPrompts' })).prompts!;
  assert.deepEqual(Object.keys(promptsB.prompts), ['normal-prompt']);

  clock.tick(100);
  const saveFromB = await deviceB.service.handleMessage({ type: 'savePrompt', prompt: { title: 'From B', content: 'Hello' } });
  assert.equal(saveFromB.ok, true);
  await cloud.flushDeliveries();

  const promptsA = (await deviceA.service.handleMessage({ type: 'getPrompts' })).prompts!;
  assert.ok(promptsA.prompts['huge-prompt'], 'Omitted oversized local prompt must NEVER be deleted by remote pull');
  assert.ok(
    Object.values(promptsA.prompts).some((p) => p.title === 'From B'),
    'Remote prompt from Device B should still merge'
  );

  // 5b. Total payload > 92,000 B -> priority packs projects + newest chats, omits oldest chats without losing them locally
  const bigChats: StoredState['chatIndex'] = {};
  for (let i = 0; i < 650; i += 1) {
    const id = `bulk-${String(i).padStart(4, '0')}`;
    bigChats[id] = {
      conversationId: id,
      title: `Bulk title ${i} ${'z'.repeat(140)}`,
      projectId: 'p1',
      updatedAt: clock.now() + i,
      lastUrl: `https://gemini.google.com/app/${id}`
    };
  }
  await localA.set({
    [STORAGE_KEY]: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      projects: [makeProject('p1', 'Main', clock.now())],
      chatIndex: bigChats,
      uiPrefs: { projectsCollapsed: false }
    }
  });
  deviceA.restartSw();
  await deviceA.service.handleMessage({ type: 'syncNow' });
  await cloud.flushDeliveries();

  statusA = (await deviceA.service.handleMessage({ type: 'getSyncStatus' })).syncStatus!;
  assert.equal(statusA.state, 'partial');
  assert.ok((statusA.omittedChats ?? 0) > 0, 'Oldest chats should be omitted gracefully');
  assert.ok(cloud.totalBytes() <= 92000, 'Synced bytes must stay under 92,000 B ceiling');

  // Subsequent edit from Device B must NEVER wipe Device A's 650 local chats
  clock.tick(5000);
  await deviceB.service.handleMessage({ type: 'upsertProject', project: makeProject('p2', 'New from B', clock.now()), editing: false });
  await cloud.flushDeliveries();
  const stateAAfterPull = (await deviceA.service.handleMessage({ type: 'getState' })).state!;
  assert.equal(Object.keys(stateAAfterPull.chatIndex).length, 650, 'All 650 local chats preserved after remote pull');

  // 5c. Runtime Chrome QUOTA_BYTES rejection -> local write still succeeds, status becomes quota_exceeded
  cloud.nextSetError = new Error('QUOTA_BYTES quota exceeded');
  const writeRes = await deviceA.service.handleMessage({
    type: 'upsertProject',
    project: makeProject('p-local-ok', 'Still Saved Locally', clock.tick(10)),
    editing: false
  });
  assert.equal(writeRes.ok, true, 'Local mutation must succeed despite sync quota error');
  assert.ok(writeRes.state?.projects.some((p) => p.id === 'p-local-ok'));
  statusA = (await deviceA.service.handleMessage({ type: 'getSyncStatus' })).syncStatus!;
  assert.equal(statusA.state, 'quota_exceeded');

  deviceA.detach();
  deviceB.detach();
});

// 6. restoreBackup propagation to another device
test('6. restoreBackup stamps entities, records tombstones for omitted items, and propagates to other devices', async () => {
  const clock = createClock();
  const cloud = new MockChromeSyncStorage();
  const deviceA = createDevice(cloud, clock);
  const deviceB = createDevice(cloud, clock);

  await deviceA.service.handleMessage({ type: 'upsertProject', project: makeProject('p1', 'Old P1', clock.now()), editing: false });
  await deviceA.service.handleMessage({ type: 'upsertProject', project: makeProject('p2', 'Will Be Omitted', clock.now()), editing: false });
  await deviceA.service.handleMessage({
    type: 'moveChat',
    conversationId: 'c1',
    projectId: 'p1',
    metadata: { conversationId: 'c1', title: 'Chat 1', lastUrl: 'https://gemini.google.com/app/c1' }
  });
  const saveOldPrompt = await deviceA.service.handleMessage({ type: 'savePrompt', prompt: { title: 'Old Prompt', content: 'Old' } });
  assert.equal(saveOldPrompt.ok, true);
  await cloud.flushDeliveries();

  // Restore backup containing only renamed p1 and new prompt pr-restored (omitting p2, c1, pr1)
  const backupPayload = {
    version: 1,
    exportedAt: new Date(clock.now()).toISOString(),
    projects: {
      schemaVersion: 1,
      projects: [makeProject('p1', 'Restored P1', 1000)],
      chatIndex: {},
      uiPrefs: { projectsCollapsed: false }
    },
    prompts: {
      version: 1,
      prompts: {
        'pr-restored': {
          id: 'pr-restored',
          title: 'Restored Prompt',
          content: 'Fresh content',
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
  await cloud.flushDeliveries();

  const stateB = (await deviceB.service.handleMessage({ type: 'getState' })).state!;
  const promptsB = (await deviceB.service.handleMessage({ type: 'getPrompts' })).prompts!;
  assert.deepEqual(stateB.projects.map((p) => [p.id, p.name]), [['p1', 'Restored P1']]);
  assert.equal(stateB.chatIndex['c1']?.projectId, null, 'Omitted assigned chat should become unassigned on Device B');
  assert.deepEqual(Object.keys(promptsB.prompts), ['pr-restored'], 'Omitted prompt should be removed on Device B');

  deviceA.detach();
  deviceB.detach();
});

// 7. Echo suppression across simulated MV3 SW restarts
test('7. Persistent echo suppression across simulated MV3 service worker restarts', async () => {
  const clock = createClock();
  const cloud = new MockChromeSyncStorage();
  const deviceA = createDevice(cloud, clock);

  await deviceA.service.handleMessage({ type: 'upsertProject', project: makeProject('p1', 'Solo', clock.now()), editing: false });
  await cloud.flushDeliveries();

  const metaSnapshot = clone(cloud.data[SYNC_META_KEY]);
  const setCallsAfterPush = cloud.setCalls;

  // Simulate MV3 Service Worker termination and cold restart
  deviceA.restartSw();

  // Replay storage.onChanged echo for the exact write we made before SW restart
  await deviceA.service.handleSyncChanged({
    [SYNC_META_KEY]: { oldValue: undefined, newValue: metaSnapshot }
  });
  await deviceA.service.handleMessage({ type: 'getState' });
  await cloud.flushDeliveries();

  assert.equal(cloud.setCalls, setCallsAfterPush, 'Echo and SW restart init must cause 0 redundant sync writes');

  deviceA.detach();
});

// 8. Toggle off/on behavior, syncNow, and rate-limit error recovery
test('8. Toggle off/on pauses and merges cleanly; rate-limit errors recover on syncNow', async () => {
  const clock = createClock();
  const cloud = new MockChromeSyncStorage();
  const deviceA = createDevice(cloud, clock);
  const deviceB = createDevice(cloud, clock);

  await deviceA.service.handleMessage({ type: 'upsertProject', project: makeProject('p1', 'Initial', clock.now()), editing: false });
  await cloud.flushDeliveries();

  // Turn sync OFF on Device A
  const offRes = await deviceA.service.handleMessage({ type: 'setSyncEnabled', enabled: false });
  assert.equal(offRes.ok, true);
  assert.equal(offRes.syncStatus?.state, 'disabled');
  assert.ok(cloud.data[SYNC_META_KEY], 'Toggling off must not delete remote data');

  // Offline edits on both devices while Device A is paused
  const setsWhenOff = cloud.setCalls;
  clock.tick(100);
  await deviceA.service.handleMessage({ type: 'upsertProject', project: makeProject('p-from-a', 'Offline A', clock.now()), editing: false });
  assert.equal(cloud.setCalls, setsWhenOff, 'Paused device must not push');

  clock.tick(100);
  await deviceB.service.handleMessage({ type: 'upsertProject', project: makeProject('p-from-b', 'Online B', clock.now()), editing: false });
  await cloud.flushDeliveries();

  const stateAWhileOff = (await deviceA.service.handleMessage({ type: 'getState' })).state!;
  assert.deepEqual(stateAWhileOff.projects.map((p) => p.id).sort(), ['p-from-a', 'p1'], 'Paused device must not pull');

  // Toggle sync back ON -> safe union merge
  const onRes = await deviceA.service.handleMessage({ type: 'setSyncEnabled', enabled: true });
  assert.equal(onRes.ok, true);
  assert.equal(onRes.syncStatus?.state, 'synced');
  await cloud.flushDeliveries();

  const stateAOn = (await deviceA.service.handleMessage({ type: 'getState' })).state!;
  const stateBOn = (await deviceB.service.handleMessage({ type: 'getState' })).state!;
  assert.deepEqual(stateAOn.projects.map((p) => p.id).sort(), ['p-from-a', 'p-from-b', 'p1']);
  assert.deepEqual(stateBOn.projects.map((p) => p.id).sort(), ['p-from-a', 'p-from-b', 'p1']);

  // Inject Chrome rate-limit error -> local write still succeeds, status becomes 'error', then syncNow recovers
  cloud.nextSetError = new Error('MAX_WRITE_OPERATIONS_PER_MINUTE quota exceeded');
  clock.tick(100);
  const editRes = await deviceA.service.handleMessage({
    type: 'upsertProject',
    project: makeProject('p-rate', 'After Rate Limit', clock.now()),
    editing: false
  });
  assert.equal(editRes.ok, true);
  let statusA = (await deviceA.service.handleMessage({ type: 'getSyncStatus' })).syncStatus!;
  assert.equal(statusA.state, 'error');

  const syncNowRes = await deviceA.service.handleMessage({ type: 'syncNow' });
  assert.equal(syncNowRes.ok, true);
  assert.equal(syncNowRes.syncStatus?.state, 'synced');
  await cloud.flushDeliveries();

  const finalB = (await deviceB.service.handleMessage({ type: 'getState' })).state!;
  assert.ok(finalB.projects.some((p) => p.id === 'p-rate'), 'syncNow should recover and propagate missed edit');

  // Verify local sync metadata is stored separately under SYNC_LOCAL_META_KEY
  const rawLocalMeta = deviceA.local.data[SYNC_LOCAL_META_KEY] as SyncLocalMeta;
  assert.equal(rawLocalMeta.enabled, true);

  deviceA.detach();
  deviceB.detach();
});

// 9. Malformed/hostile sync payload rejection & sanitization
test('9. Malformed and hostile sync payloads are rejected/sanitized without polluting or wiping local data', async () => {
  const clock = createClock();
  const cloud = new MockChromeSyncStorage();
  const now = clock.now();

  // Seed remote with a mix of hostile entries, corrupt shard, and valid entries
  cloud.data = {
    [SYNC_META_KEY]: {
      v: 1,
      clientId: 'attacker-client',
      rev: 1,
      updatedAt: now,
      hash: 'deadbeef12345678',
      shards: { projects: 2, chats: 2, prompts: 1, tombstones: 1 }
    },
    [`${SYNC_PROJECTS_PREFIX}0`]: [
      { id: '__proto__', name: 'Pollute', icon: 'coding', iconStyle: 'duotone', createdAt: now, updatedAt: now, sortIndex: 1 },
      { id: 'constructor', name: 'BadCtor', icon: 'coding', iconStyle: 'duotone', createdAt: now, updatedAt: now, sortIndex: 2 },
      { id: 'bad-color', name: 'Bad Color', icon: 'coding', iconStyle: 'duotone', color: 'red;background:url(javascript:alert(1))', createdAt: now, updatedAt: now, sortIndex: 3 },
      { id: 'bad-style', name: 'Bad Style', icon: 'coding', iconStyle: '<script>', createdAt: now, updatedAt: now, sortIndex: 4 },
      { id: 'good-proj', name: 'Safe Project', icon: 'unknown-icon-xyz', iconStyle: 'solid', color: '#336699', createdAt: now, updatedAt: now, sortIndex: 5 }
    ],
    [`${SYNC_PROJECTS_PREFIX}1`]: 'corrupt-non-array-shard',
    [`${SYNC_CHATS_PREFIX}0`]: [
      { id: '__proto__', projectId: 'good-proj', title: 'Bad ID', updatedAt: now },
      { id: 'evil-url', projectId: 'good-proj', title: 'Evil URL', lastUrl: 'javascript:alert(1)', updatedAt: now },
      { id: 'evil-host', projectId: 'good-proj', title: 'Evil Host', lastUrl: 'https://evil.example/app/evil-host', updatedAt: now },
      { id: 'good-chat', projectId: 'good-proj', title: 'Safe Chat', lastUrl: 'https://gemini.google.com/u/0/app/good-chat', updatedAt: now }
    ],
    [`${SYNC_CHATS_PREFIX}1`]: { notAnArray: true },
    [`${SYNC_PROMPTS_PREFIX}0`]: [
      { id: '__proto__', title: 'Bad', content: 'Bad', createdAt: now, updatedAt: now },
      { id: 'empty-title', title: '   ', content: 'Body', createdAt: now, updatedAt: now },
      { id: 'good-prompt', title: 'Safe Prompt', content: 'Safe Body', createdAt: now, updatedAt: now }
    ],
    [SYNC_TOMBSTONES_KEY]: {
      projects: { __proto__: now, 'valid-del': now },
      chats: 'corrupt',
      prompts: { constructor: now }
    }
  };

  const device = createDevice(cloud, clock);
  const stateRes = await device.service.handleMessage({ type: 'getState' });
  const promptsRes = await device.service.handleMessage({ type: 'getPrompts' });

  assert.equal(({} as Record<string, unknown>).Pollute, undefined, 'Object.prototype must not be polluted');
  assert.deepEqual(stateRes.state?.projects.map((p) => p.id), ['good-proj']);
  assert.equal(stateRes.state?.projects[0].icon, 'default', 'Unknown icon safely falls back to default');
  assert.deepEqual(Object.keys(stateRes.state?.chatIndex ?? {}), ['good-chat']);
  assert.equal(stateRes.state?.chatIndex['good-chat']?.lastUrl, 'https://gemini.google.com/u/0/app/good-chat');
  assert.deepEqual(Object.keys(promptsRes.prompts?.prompts ?? {}), ['good-prompt']);

  // Corrupt metadata on subsequent sync event must NOT wipe valid local data
  cloud.data = { [SYNC_META_KEY]: { v: 999, broken: true } };
  await device.service.handleSyncChanged({
    [SYNC_META_KEY]: { oldValue: undefined, newValue: cloud.data[SYNC_META_KEY] }
  });
  const afterCorrupt = await device.service.handleMessage({ type: 'getState' });
  const statusAfterCorrupt = (await device.service.handleMessage({ type: 'getSyncStatus' })).syncStatus!;
  assert.deepEqual(afterCorrupt.state?.projects.map((p) => p.id), ['good-proj'], 'Corrupt meta must never wipe local data');
  assert.equal(statusAfterCorrupt.state, 'error');

  device.detach();
});
