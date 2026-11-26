/**
 * Kubai Icons (UI Controls / Line Outline) by Kubai (@kubai087), MIT License.
 * https://icons.kubai.design/ · https://github.com/kubai087/kubai-icons
 * Copyright (c) 2026 Kubai087 and the Kubai Icons contributors
 * Static SVG exported from icons-line/ at 29b163323bb8a6ec228776b122f7ca41800f8c1a
 * using variant="outline" and strokeWidth=1.75 on a 24 × 24 viewBox.
 * See THIRD_PARTY_NOTICES.md for the complete license.
 */

let uiIconMaskInstance = 0;

export const UI_ICONS = {
  // Kubai: message-square-text
  messageSquareText: "<path d=\"M3 11.3C3 8.7 3 7.05 4.025 6.025C5.05 5 6.7 5 9.3 5L14.7 5C17.3 5 18.95 5 19.975 6.025C21 7.05 21 8.7 21 11.3L21 12.7C21 15.3 21 16.95 19.975 17.975C18.95 19 17.3 19 14.7 19L3 19Z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M8 10L16 10\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M8 14L12 14\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
  // Kubai: pencil-line
  pencilLine: "<path d=\"M6.049 20.061C4.584 20.655 3.919 20.925 3.497 20.503C3.075 20.081 3.345 19.416 3.939 17.951L4.621 16.267L16.996 3.893C17.206 3.683 17.806 3.083 18.551 3.083C19.297 3.083 19.897 3.683 20.107 3.893L20.107 3.893C20.317 4.103 20.917 4.703 20.917 5.449C20.917 6.194 20.317 6.794 20.107 7.004L7.733 19.379Z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M15.794 5.095L18.905 8.206\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M13 20L20 20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
  // Kubai: pencil
  pencil: "<path d=\"M6.049 20.061C4.584 20.655 3.919 20.925 3.497 20.503C3.075 20.081 3.345 19.416 3.939 17.951L4.621 16.267L16.996 3.893C17.206 3.683 17.806 3.083 18.551 3.083C19.297 3.083 19.897 3.683 20.107 3.893L20.107 3.893C20.317 4.103 20.917 4.703 20.917 5.449C20.917 6.194 20.317 6.794 20.107 7.004L7.733 19.379Z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M15.794 5.095L18.905 8.206\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
  // Kubai: download
  download: "<path d=\"M4 14.25V17.25A2.75 2.75 0 0 0 6.75 20H17.25A2.75 2.75 0 0 0 20 17.25V14.25\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M12 4L12 15.6\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M7 10.6L12 15.6L17 10.6\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
  // Kubai: rotate-ccw
  rotateCcw: "<path d=\"M4.529 13.05A7.75 7.75 0 1 0 7.805 6.027\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M11.111 7.175L7.805 6.027L8.953 2.72\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
  // Kubai: search
  search: "<path d=\"M4 10A6 6 0 1 1 16 10A6 6 0 1 1 4 10Z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M14.243 14.243L20 20\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
  // Kubai: plus
  plus: "<path d=\"M12 4L12 20M4 12L20 12\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
  // Kubai: x
  x: "<path d=\"M6 6L18 18M18 6L6 18\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
  // Kubai: pin
  pin: "<path d=\"M12 17L12 21\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M8 5.25C8 4.321 8 3.732 8.366 3.366C8.732 3 9.321 3 10.25 3L13.75 3C14.679 3 15.268 3 15.634 3.366C16 3.732 16 4.321 16 5.25L16 6C16 6.207 16 6.561 15.78 6.78C15.561 7 15.207 7 15 7L15 7L15 11L18.53 14.53C18.628 14.628 18.817 14.817 18.909 15.038C19 15.258 19 15.525 19 15.664L19 15.664C19 15.943 19 16.414 18.707 16.707C18.414 17 17.943 17 17.664 17L6.336 17C6.057 17 5.586 17 5.293 16.707C5 16.414 5 15.943 5 15.664L5 15.664C5 15.525 5 15.258 5.091 15.038C5.183 14.817 5.372 14.628 5.47 14.53L9 11L9 7L9 7C8.793 7 8.439 7 8.22 6.78C8 6.561 8 6.207 8 6Z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
  // Kubai: pin-off
  pinOff: "<defs><mask id=\"__K__-m0\" maskUnits=\"userSpaceOnUse\" x=\"-6\" y=\"-6\" width=\"36\" height=\"36\"><rect x=\"-6\" y=\"-6\" width=\"36\" height=\"36\" fill=\"#fff\"/><path d=\"M5.119 3.881L20.119 18.881\" fill=\"none\" stroke=\"#000\" stroke-width=\"3.75\" stroke-linecap=\"round\"/></mask><mask id=\"__K__-m1\" maskUnits=\"userSpaceOnUse\" x=\"-6\" y=\"-6\" width=\"36\" height=\"36\"><rect x=\"-6\" y=\"-6\" width=\"36\" height=\"36\" fill=\"#fff\"/><path d=\"M5.119 3.881L20.119 18.881\" fill=\"none\" stroke=\"#000\" stroke-width=\"3.75\" stroke-linecap=\"round\"/></mask></defs><g mask=\"url(#__K__-m0)\"><path d=\"M12 17L12 21\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g><g mask=\"url(#__K__-m1)\"><path d=\"M8 5.25C8 4.321 8 3.732 8.366 3.366C8.732 3 9.321 3 10.25 3L13.75 3C14.679 3 15.268 3 15.634 3.366C16 3.732 16 4.321 16 5.25L16 6C16 6.207 16 6.561 15.78 6.78C15.561 7 15.207 7 15 7L15 7L15 11L18.53 14.53C18.628 14.628 18.817 14.817 18.909 15.038C19 15.258 19 15.525 19 15.664L19 15.664C19 15.943 19 16.414 18.707 16.707C18.414 17 17.943 17 17.664 17L6.336 17C6.057 17 5.586 17 5.293 16.707C5 16.414 5 15.943 5 15.664L5 15.664C5 15.525 5 15.258 5.091 15.038C5.183 14.817 5.372 14.628 5.47 14.53L9 11L9 7L9 7C8.793 7 8.439 7 8.22 6.78C8 6.561 8 6.207 8 6Z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g><path d=\"M5.207 5.207L18.793 18.793\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
  // Kubai: trash
  trash: "<path d=\"M6 10V18.75A2.25 2.25 0 0 0 8.25 21H15.75A2.25 2.25 0 0 0 18 18.75V10\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M10 12.9L10 17.3\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M14 12.9L14 17.3\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M9 6V4A1 1 0 0 1 10 3H14A1 1 0 0 1 15 4V6M5 6L19 6\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
  // Kubai: more-vertical
  moreVertical: "<path d=\"M10 5A2 2 0 1 1 14 5A2 2 0 1 1 10 5Z\" fill=\"currentColor\"/><path d=\"M10 12A2 2 0 1 1 14 12A2 2 0 1 1 10 12Z\" fill=\"currentColor\"/><path d=\"M10 19A2 2 0 1 1 14 19A2 2 0 1 1 10 19Z\" fill=\"currentColor\"/>",
  // Kubai: chevron-down
  chevronDown: "<path d=\"M6 9.5L12 15.5L18 9.5\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
  // Kubai: chevron-right
  chevronRight: "<path d=\"M9.5 18L15.5 12L9.5 6\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
  // Kubai: chevron-up
  chevronUp: "<path d=\"M18 14.5L12 8.5L6 14.5\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
  // Kubai: log-out
  logOut: "<path d=\"M11 4H8A3 3 0 0 0 5 7V17A3 3 0 0 0 8 20H11\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><path d=\"M10 12L21 12M16 7L21 12L16 17\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
  // Kubai: folder-plus
  folderPlus: "<defs><mask id=\"__K__-m0\" maskUnits=\"userSpaceOnUse\" x=\"-6\" y=\"-6\" width=\"36\" height=\"36\"><rect x=\"-6\" y=\"-6\" width=\"36\" height=\"36\" fill=\"#fff\"/><path d=\"M11.85 16A6.15 6.15 0 1 1 24.15 16A6.15 6.15 0 1 1 11.85 16Z\" fill=\"#000\"/></mask><mask id=\"__K__-m1\" maskUnits=\"userSpaceOnUse\" x=\"-6\" y=\"-6\" width=\"36\" height=\"36\"><rect x=\"-6\" y=\"-6\" width=\"36\" height=\"36\" fill=\"#fff\"/><path d=\"M11.85 16A6.15 6.15 0 1 1 24.15 16A6.15 6.15 0 1 1 11.85 16Z\" fill=\"#000\"/></mask></defs><g mask=\"url(#__K__-m0)\"><path d=\"M3 7.7C3 6.585 3 5.879 3.439 5.439C3.879 5 4.585 5 5.7 5L7.923 5C8.45 5 8.825 5 9.123 5.151C9.422 5.302 9.643 5.605 9.955 6.03L10.915 7.338C11.115 7.611 11.257 7.806 11.449 7.903C11.641 8 11.882 8 12.221 8L16.5 8C18.357 8 19.536 8 20.268 8.732C21 9.464 21 10.643 21 12.5L21 13.6C21 15.829 21 17.243 20.121 18.121C19.243 19 17.829 19 15.6 19L8.4 19C6.171 19 4.757 19 3.879 18.121C3 17.243 3 15.829 3 13.6Z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g><g mask=\"url(#__K__-m1)\"><path d=\"M7.4 12L16.6 12\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></g><path d=\"M18 13L18 19M15 16L21 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
} as const;

export type UiIconName = keyof typeof UI_ICONS;

export function renderUiIcon(name: UiIconName, size = 18, className?: string): string {
  const inner = UI_ICONS[name].replace(/__K__/g, `gp-ui-${++uiIconMaskInstance}`);
  const cls = className ? ` class="${className}"` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg"${cls} viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" aria-hidden="true">${inner}</svg>`;
}
