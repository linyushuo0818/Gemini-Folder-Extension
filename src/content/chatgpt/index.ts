import { initFolding } from './folding';
import { initMessageTimestamps } from '../messageTimestamps';

export function initChatGPT() {
    console.log('[Gemini Projects] Initializing ChatGPT specific features...');
    initFolding();
    // ChatGPT 对话区：给每条用户问题补充时间标签
    initMessageTimestamps('chatgpt');
}
