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
    --gp-control-border: rgb(31 30 29 / .3);
    --gp-button-border: rgb(31 30 29 / .3);
    --gp-bg-hover: var(--gp-surface-elevated);
    --gp-bg-active: var(--gp-surface-elevated);
    --gp-accent: #141413;
    --gp-accent-fg: #faf9f5;
    --gp-focus: #595851;
    --gp-danger: #9d4435;
    --gp-backdrop: rgb(20 20 19 / .28);
    --gp-backdrop-blur: blur(3px);
    --gp-shadow: inset 0 1px 0 rgb(255 255 255 / .72), 0 24px 64px rgb(20 20 19 / .14), 0 4px 12px rgb(20 20 19 / .04);
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
    --gp-control-border: rgb(222 220 209 / .3);
    --gp-button-border: rgb(222 220 209 / .3);
    --gp-accent: #faf9f5;
    --gp-accent-fg: #141413;
    --gp-focus: #c2c0b6;
    --gp-danger: #e0a28b;
    --gp-backdrop: rgb(0 0 0 / .58);
    --gp-backdrop-blur: blur(4px);
    --gp-shadow: inset 0 1px 0 rgb(255 255 255 / .08), 0 24px 64px rgb(0 0 0 / .56), 0 4px 16px rgb(0 0 0 / .32);
    color-scheme: dark;
  }
`;
