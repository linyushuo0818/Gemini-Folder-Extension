export const PILL_RADIUS = '999px';
export const CIRCLE_RADIUS = '50%';

// 独立操作用胶囊／圆形；嵌套表面按实际 inset 推导，避免散落的圆角值。
export const RADIUS_TOKENS_CSS = `
  :host {
    --gp-radius-control: 12px;
    --gp-radius-pill: ${PILL_RADIUS};
    --gp-radius-circle: ${CIRCLE_RADIUS};
    --gp-menu-inset: 8px;
    --gp-menu-item-height: 36px;
    --gp-radius-menu: calc(var(--gp-menu-item-height) / 2 + var(--gp-menu-inset) + 1px);
  }
`;

// 在每个面板自身声明，响应式 inset 改变时，派生圆角会同步重算。
export const PANEL_GEOMETRY_CSS = `
  --gp-panel-border: .5px;
  --gp-panel-action-inset: 16px;
  --gp-radius-panel: calc(var(--gp-panel-inset) + var(--gp-panel-action-height) / 2 + var(--gp-panel-border));
  --gp-radius-panel-bottom: calc(var(--gp-panel-action-inset) + var(--gp-panel-action-height) / 2 + var(--gp-panel-border));
  --gp-radius-control: calc(var(--gp-panel-action-height) / 2);
  border-radius: var(--gp-radius-panel) var(--gp-radius-panel) var(--gp-radius-panel-bottom) var(--gp-radius-panel-bottom);
`;
