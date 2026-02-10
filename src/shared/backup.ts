// 扩展本地数据的备份/恢复工具。
// 这里不依赖 shared/storage.ts，避免被打进共享 chunk，
// 从而触发 content script 变成 ESM 导致在 Chrome 中失效。

const PROJECTS_KEY = 'gemini_projects_v1';
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

export async function exportAllData(): Promise<void> {
  const result = await chrome.storage.local.get([PROJECTS_KEY, PROMPTS_KEY]);
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
  if (!data || typeof data !== 'object') return null;
  if (typeof data.version !== 'number') return null;
  if (data.version > BACKUP_VERSION) return null;
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
    if (data.projects !== null && data.projects !== void 0) {
      updates[PROJECTS_KEY] = data.projects;
    }
    if (data.prompts !== null && data.prompts !== void 0) {
      updates[PROMPTS_KEY] = data.prompts;
    }

    if (!Object.keys(updates).length) {
      return { success: false, message: 'No restorable data found in backup file.' };
    }

    await chrome.storage.local.set(updates);
    return {
      success: true,
      message: data.exportedAt
        ? `Restore completed. Backup timestamp: ${data.exportedAt}`
        : 'Restore completed.'
    };
  } catch (error) {
    // eslint-disable-next-line no-console
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
