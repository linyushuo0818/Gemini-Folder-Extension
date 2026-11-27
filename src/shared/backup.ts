// 扩展本地数据的备份与恢复工具。
import { isRecord, normalizeProjectsState, STORAGE_KEY as PROJECTS_KEY } from './storage';
import { normalizePromptsData, PROMPTS_KEY, PromptsData } from './prompts';
import { BackgroundResponse, StoredState } from './types';
import { storageLocalGet, runtimeSendMessage } from './webext';

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

export function validateBackup(raw: unknown): { projects?: StoredState; prompts?: PromptsData } {
  if (!isRecord(raw) || raw.version !== BACKUP_VERSION) throw new Error('Invalid backup file format.');
  const projects = raw.projects == null ? undefined : normalizeProjectsState(raw.projects, true);
  const prompts = raw.prompts == null ? undefined : normalizePromptsData(raw.prompts, true);
  if (projects === null) throw new Error('Backup projects data is invalid or incompatible.');
  if (prompts === null) throw new Error('Backup prompts data is invalid or incompatible.');
  if (!projects && !prompts) throw new Error('No restorable data found in backup file.');
  return { projects, prompts };
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

export async function importData(file: File): Promise<{ success: boolean; message: string }> {
  try {
    const data: unknown = JSON.parse(await file.text());
    const response = await runtimeSendMessage<BackgroundResponse>({ type: 'restoreBackup', data });
    return response.ok
      ? { success: true, message: response.warning || 'Restore completed.' }
      : { success: false, message: response.error };
  } catch {
    return { success: false, message: 'Could not restore the backup. Please check the file and try again.' };
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
