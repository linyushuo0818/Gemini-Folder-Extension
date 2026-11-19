import { storageLocalGet, storageLocalSet, webext } from '../../shared/webext';

export interface Prompt {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  usageCount: number;
  lastUsedAt: number;
}

export interface PromptsData {
  prompts: Record<string, Prompt>;
  version: number;
}

const STORAGE_KEY = 'gp_prompts_store';

const SEED_PROMPTS: Array<{ title: string; content: string }> = [
  {
    title: 'Summarize',
    content: 'Please summarize the following text into bullet points, capturing the key insights and main arguments:'
  },
  {
    title: 'Code Review',
    content: 'Review the following code for bugs, performance issues, and best practices. Suggest improvements with code examples:'
  },
  {
    title: 'Bug Fix',
    content: 'I am encountering a bug. Here is the error message: "{{error}}". Here is the relevant code snippet: "{{code}}". Please analyze the root cause and provide a fix.'
  },
  {
    title: 'Email Polish',
    content: 'Rewrite the following email to be more professional and concise, while maintaining a friendly tone:'
  }
];

function createSeedData(): PromptsData {
  const now = Date.now();
  const prompts: Record<string, Prompt> = {};
  for (const seed of SEED_PROMPTS) {
    const id = crypto.randomUUID();
    prompts[id] = {
      id,
      title: seed.title,
      content: seed.content,
      createdAt: now,
      updatedAt: now,
      usageCount: 0,
      lastUsedAt: 0
    };
  }
  return { prompts, version: 1 };
}

// 兼容旧版数据结构，平滑忽略已下线的 tags / tagMeta / isFavorite 字段。
function normalizeStoredData(raw: unknown): PromptsData | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as { prompts?: unknown; version?: unknown };
  if (!candidate.prompts || typeof candidate.prompts !== 'object' || Array.isArray(candidate.prompts)) {
    return { prompts: {}, version: 1 };
  }

  const prompts: Record<string, Prompt> = {};
  const now = Date.now();
  for (const [key, item] of Object.entries(candidate.prompts as Record<string, unknown>)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : key;
    const title = typeof entry.title === 'string' ? entry.title : '';
    const content = typeof entry.content === 'string' ? entry.content : '';
    if (!id) continue;
    prompts[id] = {
      id,
      title: title || 'Untitled',
      content,
      createdAt: typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt) ? entry.createdAt : now,
      updatedAt: typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt) ? entry.updatedAt : now,
      usageCount: typeof entry.usageCount === 'number' && Number.isFinite(entry.usageCount) ? entry.usageCount : 0,
      lastUsedAt: typeof entry.lastUsedAt === 'number' && Number.isFinite(entry.lastUsedAt) ? entry.lastUsedAt : 0
    };
  }

  return {
    prompts,
    version: typeof candidate.version === 'number' && Number.isFinite(candidate.version) ? candidate.version : 1
  };
}

class PromptStore {
  private cache: PromptsData | null = null;
  private listeners: Set<() => void> = new Set();

  constructor() {
    void this.refresh();
    webext.storage?.onChanged?.addListener((
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string
    ) => {
      if (area === 'local' && changes[STORAGE_KEY]) {
        this.cache = normalizeStoredData(changes[STORAGE_KEY].newValue) ?? { prompts: {}, version: 1 };
        this.notify();
      }
    });
  }

  private async loadFromStorage(): Promise<PromptsData> {
    const result = await storageLocalGet<Record<string, unknown>>([STORAGE_KEY]);
    const raw = result[STORAGE_KEY];
    if (!raw) {
      const seeded = createSeedData();
      await this.saveToStorage(seeded);
      return seeded;
    }
    return normalizeStoredData(raw) ?? { prompts: {}, version: 1 };
  }

  private async saveToStorage(data: PromptsData): Promise<void> {
    await storageLocalSet({ [STORAGE_KEY]: data });
  }

  public async refresh(): Promise<void> {
    this.cache = await this.loadFromStorage();
    this.notify();
  }

  public getAll(): Prompt[] {
    if (!this.cache) return [];
    return Object.values(this.cache.prompts).sort((a, b) => {
      if (b.lastUsedAt !== a.lastUsedAt) return b.lastUsedAt - a.lastUsedAt;
      return b.updatedAt - a.updatedAt;
    });
  }

  public get(id: string): Prompt | undefined {
    return this.cache?.prompts[id];
  }

  public async save(prompt: Partial<Prompt> & { title: string; content: string }): Promise<void> {
    if (!this.cache) await this.refresh();
    const current = this.cache!;
    const now = Date.now();
    const existing = prompt.id ? current.prompts[prompt.id] : undefined;

    const entry: Prompt = existing
      ? {
          ...existing,
          title: prompt.title,
          content: prompt.content,
          updatedAt: now
        }
      : {
          id: prompt.id || crypto.randomUUID(),
          title: prompt.title,
          content: prompt.content,
          createdAt: now,
          updatedAt: now,
          usageCount: 0,
          lastUsedAt: 0
        };

    const next: PromptsData = {
      ...current,
      prompts: {
        ...current.prompts,
        [entry.id]: entry
      }
    };
    await this.saveToStorage(next);
    this.cache = next;
    this.notify();
  }

  public async delete(id: string): Promise<void> {
    if (!this.cache) await this.refresh();
    const current = this.cache!;
    if (!current.prompts[id]) return;

    const nextPrompts = { ...current.prompts };
    delete nextPrompts[id];
    const next: PromptsData = { ...current, prompts: nextPrompts };
    await this.saveToStorage(next);
    this.cache = next;
    this.notify();
  }

  public async trackUsage(id: string): Promise<void> {
    if (!this.cache) await this.refresh();
    const current = this.cache!;
    const existing = current.prompts[id];
    if (!existing) return;

    const next: PromptsData = {
      ...current,
      prompts: {
        ...current.prompts,
        [id]: {
          ...existing,
          usageCount: existing.usageCount + 1,
          lastUsedAt: Date.now()
        }
      }
    };
    await this.saveToStorage(next);
    this.cache = next;
    this.notify();
  }

  public subscribe(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private notify(): void {
    this.listeners.forEach((cb) => cb());
  }
}

export const promptStore = new PromptStore();
