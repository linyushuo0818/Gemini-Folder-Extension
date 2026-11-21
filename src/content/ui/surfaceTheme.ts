import { PANEL_TITLE_FONT_STACK } from './typography';
import { RADIUS_TOKENS_CSS } from './radii';

// 独立面板共用颜色与表面层级；侧栏继续沿用 Gemini 的原生样式。
export const SURFACE_THEME_CSS = `
  ${RADIUS_TOKENS_CSS}
  :host {
    --gp-font-serif: ${PANEL_TITLE_FONT_STACK};
    --gp-font-sans: "Anthropic Sans Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --gp-surface: #ffffff;
    --gp-surface-sunken: #f5f4ef;
    --gp-surface-footer: #faf9f5;
    --gp-surface-elevated: #f1efe8;
    --gp-fg: #141413;
    --gp-fg-secondary: #3d3d3a;
    --gp-fg-tertiary: #73726c;
    --gp-border: rgb(31 30 29 / .15);
    --gp-control-border: rgb(31 30 29 / .18);
    --gp-button-border: rgb(31 30 29 / .3);
    --gp-bg-hover: var(--gp-surface-elevated);
    --gp-bg-active: var(--gp-surface-elevated);
    --gp-accent: #141413;
    --gp-accent-fg: #faf9f5;
    --gp-focus: #5b7ff0;
    --gp-focus-border: rgb(91 127 240 / .62);
    --gp-focus-ring: 0 0 0 3px rgb(91 127 240 / .14);
    --gp-danger: #9d4435;
    --gp-backdrop: rgb(20 20 19 / .28);
    --gp-backdrop-blur: blur(3px);
    --gp-shadow: inset 0 1px 0 rgb(255 255 255 / .72), 0 24px 64px rgb(20 20 19 / .14), 0 4px 12px rgb(20 20 19 / .04);
    --gp-shadow-menu: inset 0 1px 0 rgb(255 255 255 / .72), 0 12px 32px rgb(20 20 19 / .14), 0 2px 8px rgb(20 20 19 / .06);
    --gp-toast-bg: #141413;
    --gp-toast-fg: #faf9f5;
    --gp-transition: .18s ease;
    color-scheme: light;
  }
  :host(.dark), :host([data-gp-theme="dark"]) {
    --gp-surface: #2c2c2a;
    --gp-surface-sunken: #21211f;
    --gp-surface-footer: #262624;
    --gp-surface-elevated: #373734;
    --gp-fg: #faf9f5;
    --gp-fg-secondary: #c2c0b6;
    --gp-fg-tertiary: #9c9a92;
    --gp-border: rgb(222 220 209 / .15);
    --gp-control-border: rgb(222 220 209 / .2);
    --gp-button-border: rgb(222 220 209 / .3);
    --gp-accent: #faf9f5;
    --gp-accent-fg: #141413;
    --gp-focus: #84a5ff;
    --gp-focus-border: rgb(132 165 255 / .58);
    --gp-focus-ring: 0 0 0 3px rgb(132 165 255 / .18);
    --gp-danger: #e0a28b;
    --gp-backdrop: rgb(0 0 0 / .58);
    --gp-backdrop-blur: blur(4px);
    --gp-shadow: inset 0 1px 0 rgb(255 255 255 / .08), 0 24px 64px rgb(0 0 0 / .56), 0 4px 16px rgb(0 0 0 / .32);
    --gp-shadow-menu: inset 0 1px 0 rgb(255 255 255 / .08), 0 14px 36px rgb(0 0 0 / .48), 0 2px 10px rgb(0 0 0 / .28);
    --gp-toast-bg: #373734;
    --gp-toast-fg: #faf9f5;
    color-scheme: dark;
  }
`;
