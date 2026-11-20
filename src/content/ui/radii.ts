export const PILL_RADIUS = '999px';
export const CIRCLE_RADIUS = '50%';
export const MENU_ITEM_RADIUS = '10px';

// 操作按钮与表面各用一套圆角，菜单外框按菜单项与内边距推导。
export const RADIUS_TOKENS_CSS = `
  :host {
    --gp-radius-control: 12px;
    --gp-radius-pill: ${PILL_RADIUS};
    --gp-radius-circle: ${CIRCLE_RADIUS};
    --gp-radius-modal: 24px;
    --gp-radius-library: 20px;
    --gp-menu-inset: 6px;
    --gp-menu-item-height: 36px;
    --gp-radius-menu-item: ${MENU_ITEM_RADIUS};
    --gp-radius-menu: calc(var(--gp-menu-inset) + var(--gp-radius-menu-item));
  }
`;
