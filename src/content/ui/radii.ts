export const PILL_RADIUS = '999px';
export const CIRCLE_RADIUS = '50%';
export const MENU_ITEM_RADIUS = '10px';

// 所有嵌套表面严格遵循 R_outer = R_inner + inset（四边等距同心），并渐进增强为超椭圆曲线。
export const RADIUS_TOKENS_CSS = `
  :host {
    --gp-radius-control: 10px;
    --gp-radius-pill: ${PILL_RADIUS};
    --gp-radius-circle: ${CIRCLE_RADIUS};
    --gp-modal-footer-inset: 14px;
    --gp-radius-modal-button: 10px;
    --gp-radius-modal: calc(var(--gp-modal-footer-inset) + var(--gp-radius-modal-button));
    --gp-library-inset: 12px;
    --gp-radius-library-item: 10px;
    --gp-radius-library: calc(var(--gp-library-inset) + var(--gp-radius-library-item));
    --gp-menu-inset: 6px;
    --gp-menu-item-height: 36px;
    --gp-radius-menu-item: ${MENU_ITEM_RADIUS};
    --gp-radius-menu: calc(var(--gp-menu-inset) + var(--gp-radius-menu-item));
  }
`;
