import { PROMPTS_KEY, Prompt, PromptsData } from '../../shared/prompts';
import { BackgroundRequest, BackgroundResponse } from '../../shared/types';
import { runtimeSendMessage, webext } from '../../shared/webext';

export type { Prompt } from '../../shared/prompts';

class PromptStore {
  private cache: PromptsData | null = null;
  private listeners: Set<() => void> = new Set();

  private revision = 0;

  constructor() {
    webext.storage?.onChanged?.addListener((
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string
    ) => {
      if (area === 'local' && changes[PROMPTS_KEY]) {
        this.revision += 1;
        this.cache = changes[PROMPTS_KEY].newValue as PromptsData | null;
        this.notify();
      }
    });
  }

  public async refresh(): Promise<void> {
    const revision = this.revision;
    const response = await this.send({ type: 'getPrompts' });
    if (revision === this.revision && response.prompts) {
      this.cache = response.prompts;
      this.notify();
    }
  }

  private async send(message: BackgroundRequest) {
    const response = await runtimeSendMessage<BackgroundResponse>(message);
    if (!response.ok) throw new Error(response.error);
    return response;
  }

  public getAll(): Prompt[] {
    if (!this.cache) return [];
    return Object.values(this.cache.prompts).sort((a, b) => {
      if (b.lastUsedAt !== a.lastUsedAt) return b.lastUsedAt - a.lastUsedAt;
      return b.updatedAt - a.updatedAt;
    });
  }

  public async save(prompt: Pick<Prompt, 'title' | 'content'> & { id?: string }): Promise<void> {
    await this.send({ type: 'savePrompt', prompt });
  }

  public async delete(id: string): Promise<void> {
    await this.send({ type: 'deletePrompt', id });
  }

  public async trackUsage(id: string): Promise<void> {
    await this.send({ type: 'trackPromptUsage', id });
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
