export const PANEL_TITLE_FONT_STACK = '"Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, "Songti SC", serif';

// 独立面板和弹窗的主标题共用同一层级，避免各模块单独调整后出现差异。
export const PANEL_TITLE_TYPOGRAPHY = `
  font-family: var(--gp-font-serif);
  font-size: 24px;
  line-height: 30px;
  font-weight: 600;
  letter-spacing: -.02em;
`;
