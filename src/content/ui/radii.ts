export const PILL_RADIUS = '999px';
export const CIRCLE_RADIUS = '50%';
export const MENU_ITEM_RADIUS = '10px';

// 统一采用标准圆形曲率（Material Design 3 尺度），避免不同曲率混用。
export const RADIUS_TOKENS_CSS = `
  :host {
    --gp-radius-control: 12px;
    --gp-radius-pill: ${PILL_RADIUS};
    --gp-radius-circle: ${CIRCLE_RADIUS};
    --gp-radius-modal: 28px;
    --gp-modal-inset: 24px;
    --gp-radius-library: 24px;
    --gp-library-inset: 16px;
    --gp-menu-inset: 6px;
    --gp-menu-item-height: 36px;
    --gp-radius-menu-item: ${MENU_ITEM_RADIUS};
    --gp-radius-menu: calc(var(--gp-menu-inset) + var(--gp-radius-menu-item));
  }
`;
