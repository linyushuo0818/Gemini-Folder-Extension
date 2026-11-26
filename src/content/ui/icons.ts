import { isProjectColor } from '../../shared/storage';
import { DEFAULT_PROJECT_ICON_STYLE, ProjectIcon, ProjectIconStyle } from '../../shared/types';
import { DUOTONE_PROJECT_ICONS } from './duotoneProjectIcons';
import { OUTLINE_PROJECT_ICONS } from './outlineProjectIcons';
import { SOLID_PROJECT_ICONS } from './solidProjectIcons';

let iconMaskInstance = 0;

export interface IconOption {
  id: ProjectIcon;
  label: string;
}

export const ADAPTIVE_PROJECT_COLOR = '#1f1f1f';
export const COLOR_OPTIONS: { color: string; label: string }[] = [
  { color: ADAPTIVE_PROJECT_COLOR, label: 'Black' },
  { color: '#E85C5C', label: 'Red' },
  { color: '#F97316', label: 'Orange' },
  { color: '#F59E0B', label: 'Yellow' },
  { color: '#22C55E', label: 'Green' },
  { color: '#3B82F6', label: 'Blue' },
  { color: '#8B5CF6', label: 'Purple' },
  { color: '#EC4899', label: 'Pink' },
];

export const MULTICOLOR_ICON_PALETTE = COLOR_OPTIONS.slice(1).map(({ color }) => color);

export function getPaletteIconColor(icon: ProjectIcon): string {
  const index = Math.max(0, ICON_OPTIONS.findIndex((option) => option.id === icon));
  return MULTICOLOR_ICON_PALETTE[index % MULTICOLOR_ICON_PALETTE.length];
}

/**
 * 项目图标选项顺序与名称。
 * Outline、Solid、Duotone 三套图形均来自 Kubai Icons（MIT）。
 */
export const ICON_OPTIONS: IconOption[] = [
  // Row 1
  { id: 'default', label: 'Folder' },
  { id: 'investing', label: 'Investing' },
  { id: 'phone', label: 'Phone' },
  { id: 'homework', label: 'Homework' },
  { id: 'writing', label: 'Writing' },

  // Row 2
  { id: 'pen', label: 'Pen' },
  { id: 'coding', label: 'Coding' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'music', label: 'Music' },
  { id: 'popcorn', label: 'Movies' },

  // Row 3
  { id: 'travel', label: 'Travel' },
  { id: 'palette', label: 'Art' },
  { id: 'health', label: 'Health' },
  { id: 'flower', label: 'Nature' },
  { id: 'lotus', label: 'Wellness' },

  // Row 4
  { id: 'briefcase', label: 'Work' },
  { id: 'chart', label: 'Analytics' },
  { id: 'apple', label: 'Food' },
  { id: 'dumbbell', label: 'Fitness' },
  { id: 'notebook', label: 'Notes' },

  // Row 5
  { id: 'scale', label: 'Legal' },
  { id: 'globe', label: 'Web' },
  { id: 'airplane', label: 'Flights' },
  { id: 'world', label: 'Explore' },
  { id: 'paw', label: 'Pets' },

  // Row 6
  { id: 'people', label: 'Social' },
  { id: 'beaker', label: 'Science' },
  { id: 'clover', label: 'Ideas' },
  { id: 'heart', label: 'Favorites' },
  { id: 'research', label: 'Research' },
];

/**
 * 将默认黑色（#1f1f1f）规范化为 currentColor，保证深浅模式下都清晰可见。
 */
export function resolveProjectIconColor(color?: string): string | undefined {
  if (!isProjectColor(color)) return undefined;
  return color.trim().toLowerCase() === ADAPTIVE_PROJECT_COLOR ? undefined : color;
}

export function renderIconSvg(
  iconId: ProjectIcon,
  style: ProjectIconStyle = DEFAULT_PROJECT_ICON_STYLE,
  colorOverride?: string
): string {
  const option = ICON_OPTIONS.find((item) => item.id === iconId) || ICON_OPTIONS[0];
  const color = resolveProjectIconColor(colorOverride);
  // Kubai 蒙版和裁切路径需要实例级 ID，避免同页多个图标互相覆盖。
  const maskId = ++iconMaskInstance;
  let shape: string;
  switch (style) {
    case 'outline': {
      const outline = OUTLINE_PROJECT_ICONS[option.id].replace(/__K__/g, `gp-outline-${maskId}`);
      shape = `<g data-gp-icon-outline>${outline}</g>`;
      break;
    }
    case 'solid': {
      const solid = SOLID_PROJECT_ICONS[option.id].replace(/__K__/g, `gp-solid-${maskId}`);
      shape = `<g data-gp-icon-solid>${solid}</g>`;
      break;
    }
    default: {
      const duotone = DUOTONE_PROJECT_ICONS[option.id].replace(/__K__/g, `gp-duotone-${maskId}`);
      shape = `<g data-gp-icon-duotone transform="scale(1.5)">${duotone}</g>`;
    }
  }
  return `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18"
         ${color ? `style="color:${color}"` : ''}
         fill="none" aria-hidden="true">
      ${shape}
    </svg>
  `;
}

/**
 * 获取图标标签
 */
export function getIconLabel(iconId: ProjectIcon): string {
  return ICON_OPTIONS.find((item) => item.id === iconId)?.label || 'Folder';
}
