
// import { v4 as uuidv4 } from 'uuid';

function uuidv4() {
    return crypto.randomUUID();
}

export interface Prompt {
    id: string;
    title: string;
    content: string;
    tags: string[];
    createdAt: number;
    updatedAt: number;
    usageCount: number;
    lastUsedAt: number;
    isFavorite: boolean;
}

// Notion 椋庢牸鐨?Tag 棰滆壊棰勮
export const TAG_COLORS = [
    { name: 'gray', bg: 'rgba(31,31,31,0.14)', fg: '#1f1f1f' },
    { name: 'red', bg: 'rgba(232,92,92,0.15)', fg: '#E85C5C' },
    { name: 'orange', bg: 'rgba(249,115,22,0.15)', fg: '#F97316' },
    { name: 'yellow', bg: 'rgba(245,158,11,0.15)', fg: '#F59E0B' },
    { name: 'green', bg: 'rgba(34,197,94,0.15)', fg: '#22C55E' },
    { name: 'blue', bg: 'rgba(59,130,246,0.15)', fg: '#3B82F6' },
    { name: 'purple', bg: 'rgba(139,92,246,0.15)', fg: '#8B5CF6' },
    { name: 'pink', bg: 'rgba(236,72,153,0.15)', fg: '#EC4899' },
];

// Tag 鍏冩暟鎹?
export interface TagMeta {
    name: string;
    color: string; // 棰滆壊鍚嶇О锛屽搴?TAG_COLORS
}

export interface PromptsData {
    prompts: Record<string, Prompt>;
    tagMeta: Record<string, TagMeta>; // tagName -> TagMeta
    version: number;
}

const STORAGE_KEY = 'gp_prompts_store';
const TAG_COLOR_NAMES = new Set(TAG_COLORS.map((item) => item.name));
const DEFAULT_DATA: PromptsData = {
    prompts: {},
    tagMeta: {},
    version: 1,
};

// Seed data for first run
const SEED_PROMPTS: Partial<Prompt>[] = [
    {
        title: 'Summarize',
        content: 'Please summarize the following text into bullet points, capturing the key insights and main arguments:',
        tags: ['writing', 'summary'],
    },
    {
        title: 'Code Review',
        content: 'Review the following code for bugs, performance issues, and best practices. Suggest improvements with code examples:',
        tags: ['coding', 'review'],
    },
    {
        title: 'Bug Fix',
        content: 'I am encountering a bug. Here is the error message: "{{error}}". Here is the relevant code snippet: "{{code}}". Please analyze the root cause and provide a fix.',
        tags: ['coding', 'debug'],
    },
    {
        title: 'Email Polish',
        content: 'Rewrite the following email to be more professional and concise, while maintaining a friendly tone:',
        tags: ['writing', 'email'],
    }
];

function decodeTagEntities(value: string): string {
    return value
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'");
}

function normalizeTagName(rawTag: string): string {
    if (!rawTag) return '';
    let value = decodeTagEntities(rawTag).trim();

    // Clean known artifacts introduced by broken template strings.
    value = value
        .replace(/<\s*span\s*>/gi, ' ')
        .replace(/<\s*\/\s*span\s*>/gi, ' ')
        .replace(/<\s*span[^>]*>/gi, ' ')
        .replace(/<\/\s*span\s*>/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return value;
}

function normalizePromptTags(tags: unknown): string[] {
    if (!Array.isArray(tags)) return [];
    const normalized: string[] = [];
    const seen = new Set<string>();
    tags.forEach((tag) => {
        const clean = normalizeTagName(typeof tag === 'string' ? tag : String(tag || ''));
        if (!clean || seen.has(clean)) return;
        seen.add(clean);
        normalized.push(clean);
    });
    return normalized;
}

function areStringArraysEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

class PromptStore {
    private cache: PromptsData | null = null;
    private listeners: Set<() => void> = new Set();

    constructor() {
        this.refresh();
        // Listen for storage changes
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes[STORAGE_KEY]) {
                this.cache = changes[STORAGE_KEY].newValue;
                this.notify();
            }
        });
    }

    private async loadFromStorage(): Promise<PromptsData> {
        return new Promise((resolve) => {
            chrome.storage.local.get([STORAGE_KEY], (result) => {
                let data = result[STORAGE_KEY] as PromptsData;
                if (!data) {
                    data = this.seed(DEFAULT_DATA);
                    this.saveToStorage(data);
                } else {
                    let hasDirtyData = false;
                    if (!data.prompts || typeof data.prompts !== 'object') {
                        data.prompts = {};
                        hasDirtyData = true;
                    }
                    if (!data.tagMeta || typeof data.tagMeta !== 'object') {
                        data.tagMeta = {};
                        hasDirtyData = true;
                    }

                    Object.values(data.prompts).forEach((prompt) => {
                        const currentTags = Array.isArray(prompt.tags) ? prompt.tags : [];
                        const normalizedTags = normalizePromptTags(currentTags);
                        if (!areStringArraysEqual(currentTags, normalizedTags)) {
                            prompt.tags = normalizedTags;
                            hasDirtyData = true;
                        }
                    });

                    const nextTagMeta: Record<string, TagMeta> = {};
                    Object.entries(data.tagMeta).forEach(([rawName, meta]) => {
                        const normalizedName = normalizeTagName(rawName);
                        if (!normalizedName) {
                            hasDirtyData = true;
                            return;
                        }

                        const metaColor =
                            meta && typeof meta.color === 'string' && TAG_COLOR_NAMES.has(meta.color)
                                ? meta.color
                                : 'gray';

                        const existing = nextTagMeta[normalizedName];
                        if (!existing) {
                            nextTagMeta[normalizedName] = { name: normalizedName, color: metaColor };
                        } else if (existing.color === 'gray' && metaColor !== 'gray') {
                            existing.color = metaColor;
                            hasDirtyData = true;
                        } else {
                            hasDirtyData = true;
                        }

                        if (
                            normalizedName !== rawName ||
                            !meta ||
                            meta.name !== normalizedName ||
                            !(meta && typeof meta.color === 'string' && TAG_COLOR_NAMES.has(meta.color))
                        ) {
                            hasDirtyData = true;
                        }
                    });

                    Object.values(data.prompts).forEach((prompt) => {
                        prompt.tags.forEach((tag) => {
                            if (!nextTagMeta[tag]) {
                                nextTagMeta[tag] = { name: tag, color: 'gray' };
                                hasDirtyData = true;
                            }
                        });
                    });

                    data.tagMeta = nextTagMeta;
                    if (hasDirtyData) {
                        this.saveToStorage(data);
                    }
                }
                resolve(data);
            });
        });
    }

    private seed(data: PromptsData): PromptsData {
        // Only seed if empty
        if (Object.keys(data.prompts).length === 0) {
            const now = Date.now();
            SEED_PROMPTS.forEach(p => {
                const id = uuidv4();
                data.prompts[id] = {
                    id,
                    title: p.title || 'Untitled',
                    content: p.content || '',
                    tags: p.tags || [],
                    createdAt: now,
                    updatedAt: now,
                    usageCount: 0,
                    lastUsedAt: 0,
                    isFavorite: false
                };
            });
        }
        return data;
    }

    private saveToStorage(data: PromptsData) {
        chrome.storage.local.set({ [STORAGE_KEY]: data });
    }

    public async refresh() {
        this.cache = await this.loadFromStorage();
        this.notify();
    }

    public getAll(): Prompt[] {
        if (!this.cache) return [];
        return Object.values(this.cache.prompts).sort((a, b) => {
            // Favorite first, then last used, then title
            if (a.isFavorite !== b.isFavorite) return b.isFavorite ? 1 : -1;
            if (b.lastUsedAt !== a.lastUsedAt) return b.lastUsedAt - a.lastUsedAt;
            return 0; // a.title.localeCompare(b.title);
        });
    }

    public get(id: string): Prompt | undefined {
        return this.cache?.prompts[id];
    }

    public async save(prompt: Partial<Prompt> & { title: string; content: string }) {
        if (!this.cache) await this.refresh();
        const data = this.cache!;
        const now = Date.now();
        const normalizedTags = normalizePromptTags(prompt.tags || []);

        let entry: Prompt;
        if (prompt.id && data.prompts[prompt.id]) {
            // Update
            entry = {
                ...data.prompts[prompt.id],
                ...prompt,
                tags: normalizedTags,
                updatedAt: now
            };
        } else {
            // Create
            const id = uuidv4();
            entry = {
                id,
                title: prompt.title,
                content: prompt.content,
                tags: normalizedTags,
                createdAt: now,
                updatedAt: now,
                usageCount: 0,
                lastUsedAt: 0,
                isFavorite: prompt.isFavorite || false
            };
        }

        data.prompts[entry.id] = entry;
        if (!data.tagMeta) data.tagMeta = {};
        normalizedTags.forEach((tag) => {
            if (!data.tagMeta[tag]) {
                data.tagMeta[tag] = { name: tag, color: 'gray' };
            }
        });
        this.saveToStorage(data);
    }

    public async delete(id: string) {
        if (!this.cache) await this.refresh();
        const data = this.cache!;
        if (data.prompts[id]) {
            delete data.prompts[id];
            this.saveToStorage(data);
        }
    }

    public async trackUsage(id: string) {
        if (!this.cache) await this.refresh();
        const data = this.cache!;
        if (data.prompts[id]) {
            data.prompts[id].usageCount++;
            data.prompts[id].lastUsedAt = Date.now();
            this.saveToStorage(data);
        }
    }

    public async toggleFavorite(id: string) {
        if (!this.cache) await this.refresh();
        const data = this.cache!;
        if (data.prompts[id]) {
            data.prompts[id].isFavorite = !data.prompts[id].isFavorite;
            this.saveToStorage(data);
        }
    }

    public subscribe(callback: () => void) {
        this.listeners.add(callback);
        return () => this.listeners.delete(callback);
    }

    private notify() {
        this.listeners.forEach(cb => cb());
    }

    // ========== Tag 绠＄悊鏂规硶 ==========

    // 鑾峰彇鎵€鏈変娇鐢ㄤ腑鐨?tags锛堝甫浣跨敤娆℃暟锛?
    public getAllTags(): { name: string; count: number; color: string }[] {
        if (!this.cache) return [];
        const tagCounts: Record<string, number> = {};

        // 1. 缁熻 Prompts 涓娇鐢ㄧ殑 Tags
        Object.values(this.cache.prompts).forEach(p => {
            p.tags.forEach(t => tagCounts[t] = (tagCounts[t] || 0) + 1);
        });

        // 2. 纭繚 tagMeta 涓殑 Tags 涔熻鍖呭惈锛堝嵆浣?count 涓?0锛?
        const tagMeta = this.cache.tagMeta || {};
        Object.keys(tagMeta).forEach(t => {
            if (tagCounts[t] === undefined) {
                tagCounts[t] = 0;
            }
        });

        return Object.entries(tagCounts)
            .map(([name, count]) => ({
                name,
                count,
                color: tagMeta[name]?.color || this.getRandomColor()
            }))
            .sort((a, b) => b.count - a.count); // 鎸?count 鍊掑簭锛屽悓 count 鎸夊悕绉? 鏆傛椂鍙寜 count
    }

    // 鑾峰彇 tag 鐨勯鑹?
    public getTagColor(tagName: string): string {
        const normalizedTag = normalizeTagName(tagName);
        if (!normalizedTag) return 'gray';
        return this.cache?.tagMeta[normalizedTag]?.color || 'gray';
    }

    // 闅忔満鍒嗛厤棰滆壊
    private getRandomColor(): string {
        const colors = TAG_COLORS.map(c => c.name);
        return colors[Math.floor(Math.random() * colors.length)];
    }

    // 纭繚 tag 鏈夐鑹诧紙鍒涘缓鏃惰皟鐢級
    public async ensureTagColor(tagName: string): Promise<string> {
        const normalizedTag = normalizeTagName(tagName);
        if (!normalizedTag) return 'gray';
        if (!this.cache) await this.refresh();
        const data = this.cache!;

        if (!data.tagMeta) data.tagMeta = {}; // Ensure tagMeta exists

        if (!data.tagMeta[normalizedTag]) {
            const color = this.getRandomColor();
            data.tagMeta[normalizedTag] = { name: normalizedTag, color };
            this.saveToStorage(data);
            return color;
        }
        return data.tagMeta[normalizedTag].color;
    }

    // 璁剧疆 tag 棰滆壊
    public async setTagColor(tagName: string, color: string) {
        const normalizedTag = normalizeTagName(tagName);
        if (!normalizedTag) return;
        if (!this.cache) await this.refresh();
        const data = this.cache!;
        if (!data.tagMeta) data.tagMeta = {}; // Ensure tagMeta exists

        data.tagMeta[normalizedTag] = { name: normalizedTag, color };
        this.saveToStorage(data);
    }

    // 閲嶅懡鍚?tag锛堟洿鏂版墍鏈?prompts锛?
    public async renameTag(oldName: string, newName: string) {
        const oldTag = normalizeTagName(oldName);
        const nextTag = normalizeTagName(newName);
        if (!oldTag || !nextTag) return;
        if (oldTag === nextTag) return;

        if (!this.cache) await this.refresh();
        const data = this.cache!;

        // 鏇存柊鎵€鏈?prompts 涓殑 tag
        Object.values(data.prompts).forEach(p => {
            p.tags = normalizePromptTags(p.tags.map((tag) => (tag === oldTag ? nextTag : tag)));
        });

        // 鏇存柊 tagMeta
        if (!data.tagMeta) data.tagMeta = {}; // Ensure tagMeta exists
        if (data.tagMeta[oldTag]) {
            const oldColor = data.tagMeta[oldTag].color;
            if (!data.tagMeta[nextTag]) {
                data.tagMeta[nextTag] = { name: nextTag, color: oldColor };
            }
            delete data.tagMeta[oldTag];
        } else if (!data.tagMeta[nextTag]) {
            data.tagMeta[nextTag] = { name: nextTag, color: 'gray' };
        }

        this.saveToStorage(data);
        this.notify();
    }

    // 鍒犻櫎 tag锛堜粠鎵€鏈?prompts 绉婚櫎锛?
    public async deleteTagGlobal(tagName: string) {
        const normalizedTag = normalizeTagName(tagName);
        if (!normalizedTag) return;
        if (!this.cache) await this.refresh();
        const data = this.cache!;

        // 浠庢墍鏈?prompts 绉婚櫎姝?tag
        Object.values(data.prompts).forEach(p => {
            p.tags = p.tags.filter(t => t !== normalizedTag);
        });

        // 鍒犻櫎 tagMeta
        if (data.tagMeta) {
            delete data.tagMeta[normalizedTag];
        }

        this.saveToStorage(data);
        this.notify();
    }
}

export const promptStore = new PromptStore();

