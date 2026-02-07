
import { injectPromptButton } from './injector';
import { PromptPicker } from './picker';

export function bootstrap() {
    injectPromptButton(() => {
        const btn = document.getElementById('gp-prompt-btn');
        if (btn) {
            const rect = btn.getBoundingClientRect();
            PromptPicker.getInstance().toggle(rect);
        }
    });
}
