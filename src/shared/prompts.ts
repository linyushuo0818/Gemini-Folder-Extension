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
// 使用基线时间戳 1，避免本地离线生成的默认提示词覆盖其他设备的修改或复活已删除条目。
export const SEED_PROMPT_TIMESTAMP = 1;

const SEED_PROMPTS: Array<{ id: string; title: string; content: string }> = [
  {
    id: 'seed-summarize',
    title: 'Summarize',
    content: 'Please summarize the following text into bullet points, capturing the key insights and main arguments:'
  },
  {
    id: 'seed-code-review',
    title: 'Code Review',
    content: 'Review the following code for bugs, performance issues, and best practices. Suggest improvements with code examples:'
  },
  {
    id: 'seed-bug-fix',
    title: 'Bug Fix',
    content: 'I am encountering a bug. Here is the error message: "{{error}}". Here is the relevant code snippet: "{{code}}". Please analyze the root cause and provide a fix.'
  },
  {
    id: 'seed-email-polish',
    title: 'Email Polish',
    content: 'Rewrite the following email to be more professional and concise, while maintaining a friendly tone:'
  }
];

export function matchUnmodifiedSeedId(title: string, content: string): string | null {
  for (const seed of SEED_PROMPTS) {
    if (title === seed.title && content === seed.content) return seed.id;
  }
  return null;
}

export function createSeedData(): PromptsData {
  const prompts: Record<string, Prompt> = {};
  for (const seed of SEED_PROMPTS) {
    prompts[seed.id] = {
      id: seed.id,
      title: seed.title,
      content: seed.content,
      createdAt: SEED_PROMPT_TIMESTAMP,
      updatedAt: SEED_PROMPT_TIMESTAMP,
      usageCount: 0,
      lastUsedAt: 0
    };
  }
  return { prompts, version: 1 };
}

export function sanitizePrompt(
  raw: unknown,
  fallbackId?: string,
  strict = false
): Prompt | null {
  if (!isRecord(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : (fallbackId ?? '');
  const title = typeof entry.title === 'string' ? entry.title : '';
  const content = typeof entry.content === 'string' ? entry.content : '';
  if (!isSafeId(id) || (strict && (!title.trim() || !content.trim()))) return null;

  const now = Date.now();
  return {
    id,
    title: title || 'Untitled',
    content,
    createdAt: typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt) ? entry.createdAt : now,
    updatedAt: typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt) ? entry.updatedAt : now,
    usageCount: typeof entry.usageCount === 'number' && Number.isFinite(entry.usageCount) ? entry.usageCount : 0,
    lastUsedAt: typeof entry.lastUsedAt === 'number' && Number.isFinite(entry.lastUsedAt) ? entry.lastUsedAt : 0
  };
}

// 兼容旧版数据结构，平滑忽略已下线的 tags / tagMeta / isFavorite 字段。
export function normalizePromptsData(raw: unknown, strict = false): PromptsData | null {
  if (!isRecord(raw)) return null;
  const candidate = raw as { prompts?: unknown; version?: unknown };
  if (!isRecord(candidate.prompts) || (candidate.version !== undefined && candidate.version !== 1)) return null;

  const prompts: Record<string, Prompt> = {};
  for (const [key, item] of Object.entries(candidate.prompts as Record<string, unknown>)) {
    const prompt = sanitizePrompt(item, key, strict);
    if (!prompt || Object.hasOwn(prompts, prompt.id)) {
      if (strict) return null;
      continue;
    }
    prompts[prompt.id] = prompt;
  }

  return {
    prompts,
    version: typeof candidate.version === 'number' && Number.isFinite(candidate.version) ? candidate.version : 1
  };
}
