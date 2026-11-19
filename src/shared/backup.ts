// 扩展本地数据的备份与恢复工具。
import { normalizeProjectsState, STORAGE_KEY as PROJECTS_KEY } from './storage';
import { storageLocalGet, storageLocalSet } from './webext';

const PROMPTS_KEY = 'gp_prompts_store';
const BACKUP_VERSION = 1;

export interface BackupData {
  version: number;
  exportedAt: string;
  projects: unknown;
  prompts: unknown;
}

function buildFilename(): string {
  const date = new Date();
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `gemini-projects-backup-${yyyy}-${mm}-${dd}.json`;
}

function normalizePromptsBackup(raw: unknown): { prompts: Record<string, unknown>; version: number } | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as { prompts?: unknown; version?: unknown };
  if (!candidate.prompts || typeof candidate.prompts !== 'object' || Array.isArray(candidate.prompts)) {
    return null;
  }

  const sanitized: Record<string, unknown> = {};
  const now = Date.now();
  for (const [key, item] of Object.entries(candidate.prompts as Record<string, unknown>)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : key;
    const title = typeof entry.title === 'string' ? entry.title.trim() : '';
    const content = typeof entry.content === 'string' ? entry.content : '';
    if (!id || !title || !content.trim()) continue;
    sanitized[id] = {
      id,
      title,
      content,
      createdAt: typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt) ? entry.createdAt : now,
      updatedAt: typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt) ? entry.updatedAt : now,
      usageCount: typeof entry.usageCount === 'number' && Number.isFinite(entry.usageCount) ? entry.usageCount : 0,
      lastUsedAt: typeof entry.lastUsedAt === 'number' && Number.isFinite(entry.lastUsedAt) ? entry.lastUsedAt : 0
    };
  }

  return {
    prompts: sanitized,
    version: typeof candidate.version === 'number' && Number.isFinite(candidate.version) ? candidate.version : 1
  };
}

export async function exportAllData(): Promise<void> {
  const result = await storageLocalGet<Record<string, unknown>>([PROJECTS_KEY, PROMPTS_KEY]);
  const payload: BackupData = {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    projects: result[PROJECTS_KEY] ?? null,
    prompts: result[PROMPTS_KEY] ?? null
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = buildFilename();
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function parseBackupText(text: string): BackupData | null {
  const data = JSON.parse(text) as BackupData;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (typeof data.version !== 'number') return null;
  if (data.version > BACKUP_VERSION || data.version < 1) return null;
  return data;
}

export async function importData(file: File): Promise<{ success: boolean; message: string }> {
  try {
    const text = await file.text();
    const data = parseBackupText(text);
    if (!data) {
      return { success: false, message: 'Invalid backup file format.' };
    }

    const updates: Record<string, unknown> = {};
    if (data.projects !== null && data.projects !== undefined) {
      const normalizedProjects = normalizeProjectsState(data.projects);
      if (!normalizedProjects) {
        return { success: false, message: 'Backup projects data is invalid or incompatible.' };
      }
      updates[PROJECTS_KEY] = normalizedProjects;
    }

    if (data.prompts !== null && data.prompts !== undefined) {
      const normalizedPrompts = normalizePromptsBackup(data.prompts);
      if (!normalizedPrompts) {
        return { success: false, message: 'Backup prompts data is invalid or incompatible.' };
      }
      updates[PROMPTS_KEY] = normalizedPrompts;
    }

    if (!Object.keys(updates).length) {
      return { success: false, message: 'No restorable data found in backup file.' };
    }

    await storageLocalSet(updates);
    return {
      success: true,
      message: data.exportedAt
        ? `Restore completed. Backup timestamp: ${data.exportedAt}`
        : 'Restore completed.'
    };
  } catch (error) {
    console.error('[Backup] import failed', error);
    return { success: false, message: 'Failed to read or parse the backup file.' };
  }
}

export function triggerImport(
  onComplete?: (result: { success: boolean; message: string }) => void
): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const result = await importData(file);
    onComplete?.(result);
  };
  input.click();
}
