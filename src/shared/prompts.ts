import { isRecord, isSafeId } from './storage';

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

export const PROMPTS_KEY = 'gp_prompts_store';

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

export function createSeedData(): PromptsData {
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
export function normalizePromptsData(raw: unknown, strict = false): PromptsData | null {
  if (!isRecord(raw)) return null;
  const candidate = raw as { prompts?: unknown; version?: unknown };
  if (!isRecord(candidate.prompts) || (candidate.version !== undefined && candidate.version !== 1)) return null;

  const prompts: Record<string, Prompt> = {};
  const now = Date.now();
  for (const [key, item] of Object.entries(candidate.prompts as Record<string, unknown>)) {
    if (!isRecord(item)) {
      if (strict) return null;
      continue;
    }
    const entry = item as Record<string, unknown>;
    const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : key;
    const title = typeof entry.title === 'string' ? entry.title : '';
    const content = typeof entry.content === 'string' ? entry.content : '';
    if (!isSafeId(id) || Object.hasOwn(prompts, id) || (strict && (!title.trim() || !content.trim()))) {
      if (strict) return null;
      continue;
    }
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
