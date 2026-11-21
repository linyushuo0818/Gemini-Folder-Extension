export const PILL_RADIUS = '999px';
export const CIRCLE_RADIUS = '50%';
export const MENU_ITEM_RADIUS = PILL_RADIUS;

// 统一采用全圆胶囊 + 严格同心派生（R_outer = R_inner + inset + border），全界面保持单一曲率。
export const RADIUS_TOKENS_CSS = `
  :host {
    --gp-radius-pill: ${PILL_RADIUS};
    --gp-radius-circle: ${CIRCLE_RADIUS};
    --gp-radius-control: ${PILL_RADIUS};

    --gp-project-action-height: 40px;
    --gp-project-footer-inset: 14px;
    --gp-radius-project-modal: calc(var(--gp-project-action-height) / 2 + var(--gp-project-footer-inset) + .5px);

    --gp-prompt-action-height: 36px;
    --gp-prompt-footer-inset: 14px;
    --gp-radius-prompt-modal: calc(var(--gp-prompt-action-height) / 2 + var(--gp-prompt-footer-inset) + .5px);
    --gp-radius-prompt-textarea: calc(var(--gp-prompt-action-height) / 2);

    --gp-library-inset: 12px;
    --gp-radius-library-item: calc(var(--gp-prompt-action-height) / 2);
    --gp-radius-library: calc(var(--gp-radius-library-item) + var(--gp-library-inset) + .5px);

    --gp-menu-inset: 6px;
    --gp-menu-item-height: 36px;
    --gp-radius-menu-item: ${MENU_ITEM_RADIUS};
    --gp-radius-menu: calc(var(--gp-menu-item-height) / 2 + var(--gp-menu-inset) + 1px);
  }
`;
