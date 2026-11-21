import { PROJECT_ICON_STYLES } from '../../shared/types';

export const PROJECT_ICON_STYLE_CSS = `
  :host {
    --gp-icon-switcher-track: #eae7df;
    --gp-icon-switcher-track-shadow: inset 0 1px 2px rgb(20 20 19 / .05);
    --gp-icon-switcher-active-bg: #ffffff;
    --gp-icon-switcher-active-shadow: 0 1px 3px rgb(20 20 19 / .12), 0 .5px 1px rgb(20 20 19 / .06);
  }
  :host(.dark), :host([data-gp-theme="dark"]) {
    --gp-icon-switcher-track: #1d1d1b;
    --gp-icon-switcher-track-shadow: inset 0 1px 2px rgb(0 0 0 / .24);
    --gp-icon-switcher-active-bg: #40403c;
    --gp-icon-switcher-active-shadow: inset 0 1px 0 rgb(255 255 255 / .12), 0 1px 4px rgb(0 0 0 / .36);
  }
  .gp-icon-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px 12px;
    flex-wrap: wrap;
    width: 100%;
    min-width: 0;
  }
  .gp-icon-style-switcher {
    display: inline-grid;
    grid-template-columns: repeat(${PROJECT_ICON_STYLES.length}, minmax(0, 1fr));
    align-items: center;
    gap: 2px;
    padding: 3px;
    border-radius: var(--gp-radius-pill);
    background: var(--gp-icon-switcher-track);
    box-shadow: var(--gp-icon-switcher-track-shadow);
    border: .5px solid var(--gp-border);
    max-width: 100%;
    flex-shrink: 0;
  }
  .gp-template-grid svg {
    color: var(--gp-grid-icon-color, inherit);
  }
  [data-gp-icon-palette] .gp-template-grid svg {
    color: var(--gp-icon-palette-color);
  }
  .gp-icon-style-option {
    position: relative;
    display: inline-flex;
    min-width: 0;
    margin: 0;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  /* 保留覆盖选项区域的真实尺寸，确保键盘焦点、弹窗 Tab 捕获与触屏点击均可命中原生 radio。 */
  .gp-icon-style-option input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: pointer;
    appearance: none;
    -webkit-appearance: none;
  }
  .gp-icon-style-option span {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    min-height: 26px;
    padding: 0 11px;
    border-radius: var(--gp-radius-pill);
    font-family: var(--gp-font-sans);
    font-size: 12px;
    font-weight: 500;
    line-height: 16px;
    letter-spacing: 0;
    color: var(--gp-fg-tertiary);
    background: transparent;
    white-space: nowrap;
    user-select: none;
    transition: background-color var(--gp-transition), color var(--gp-transition), box-shadow var(--gp-transition);
  }
  .gp-icon-style-option:hover input:not(:disabled):not(:checked) + span {
    color: var(--gp-fg-secondary);
  }
  .gp-icon-style-option input:checked + span {
    background: var(--gp-icon-switcher-active-bg);
    color: var(--gp-fg);
    box-shadow: var(--gp-icon-switcher-active-shadow);
  }
  .gp-icon-style-option input:focus-visible + span {
    outline: 2px solid var(--gp-focus);
    outline-offset: 2px;
  }
  .gp-icon-style-option input:disabled {
    cursor: not-allowed;
  }
  .gp-icon-style-option input:disabled + span {
    opacity: .55;
    cursor: not-allowed;
  }
  @media (pointer: coarse) {
    .gp-icon-style-option span {
      min-height: 32px;
      padding: 0 12px;
    }
  }
  @media (max-width: 360px) {
    .gp-icon-toolbar {
      gap: 6px 8px;
    }
    .gp-icon-style-option span {
      padding: 0 9px;
      font-size: 11.5px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .gp-icon-style-option span {
      transition: none;
    }
  }
`;
