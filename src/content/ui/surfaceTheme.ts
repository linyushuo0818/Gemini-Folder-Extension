import { PANEL_TITLE_FONT_STACK } from './typography';
import { RADIUS_TOKENS_CSS } from './radii';

// 独立面板共用颜色与表面层级；侧栏继续沿用 Gemini 的原生样式。
export const SURFACE_THEME_CSS = `
  ${RADIUS_TOKENS_CSS}
  :host {
    --gp-font-serif: ${PANEL_TITLE_FONT_STACK};
    --gp-font-sans: "Anthropic Sans Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --gp-surface: #ffffff;
    --gp-surface-elevated: #faf9f5;
    --gp-fg: #141413;
    --gp-fg-secondary: #3d3d3a;
    --gp-fg-tertiary: #73726c;
    --gp-border: rgb(31 30 29 / .15);
    --gp-control-border: rgb(31 30 29 / .3);
    --gp-button-border: rgb(31 30 29 / .3);
    --gp-bg-hover: #f5f4ed;
    --gp-bg-active: #f5f4ed;
    --gp-accent: #141413;
    --gp-accent-fg: #faf9f5;
    --gp-focus: #595851;
    --gp-danger: #9d4435;
    --gp-backdrop: rgb(20 20 19 / .32);
    --gp-shadow: 0 24px 64px #14141324, 0 4px 12px #1414130a;
    --gp-transition: .18s ease;
    color-scheme: light;
  }
  :host(.dark), :host([data-gp-theme="dark"]) {
    --gp-surface: #30302e;
    --gp-surface-elevated: #262624;
    --gp-fg: #faf9f5;
    --gp-fg-secondary: #c2c0b6;
    --gp-fg-tertiary: #9c9a92;
    --gp-border: rgb(222 220 209 / .15);
    --gp-control-border: rgb(222 220 209 / .3);
    --gp-button-border: rgb(222 220 209 / .3);
    --gp-bg-hover: #3d3d3a;
    --gp-bg-active: #3d3d3a;
    --gp-accent: #faf9f5;
    --gp-accent-fg: #141413;
    --gp-focus: #c2c0b6;
    --gp-danger: #e0a28b;
    --gp-backdrop: rgb(0 0 0 / .48);
    --gp-shadow: 0 24px 64px #0006, 0 4px 12px #0003;
    color-scheme: dark;
  }
`;
