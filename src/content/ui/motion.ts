// Adapted from Transitions.dev menu dropdown, modal and toast recipes.
// https://github.com/Jakubantalik/transitions.dev (Transitions.dev License)
type SurfaceKind = 'menu' | 'modal' | 'toast';
type SurfaceState = { timer?: number };
const surfaces = new WeakMap<HTMLElement, SurfaceState>();
export const MOTION_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
let keyboardInput = false;
let pressedControl: HTMLElement | null = null;
const releasePress = () => {
  pressedControl?.removeAttribute('data-gp-pressing');
  pressedControl = null;
};
document.addEventListener('keydown', () => { keyboardInput = true; }, true);
document.addEventListener('pointerdown', (event) => {
  keyboardInput = false;
  releasePress();
  if (event.button !== 0) return;
  const control = event.composedPath().find((node) =>
    node instanceof HTMLElement && node.hasAttribute('data-gp-press')
  ) as HTMLButtonElement | undefined;
  if (control && !control.disabled) {
    pressedControl = control;
    control.setAttribute('data-gp-pressing', '');
  }
}, true);
document.addEventListener('pointerup', releasePress, true);
document.addEventListener('pointercancel', releasePress, true);
window.addEventListener('blur', releasePress);

export function shouldAnimateMotion() {
  return !keyboardInput && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const styles = `
  :root, :host {
    --gp-motion-ease: ${MOTION_EASE};
    --gp-motion-open: 250ms;
    --gp-motion-close: 150ms;
  }
  [data-gp-motion] {
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--gp-motion-close) var(--gp-motion-ease),
                transform var(--gp-motion-close) var(--gp-motion-ease);
  }
  [data-gp-motion="menu"] { transform: scale(.97); }
  [data-gp-motion="modal"] > [data-gp-motion-surface] {
    transform: scale(.96);
    transform-origin: center;
    transition: transform var(--gp-motion-close) var(--gp-motion-ease);
  }
  [data-gp-motion="toast"] {
    --gp-motion-open: 250ms;
    --gp-motion-close: 250ms;
    transform: translateY(16px) scale(.97);
  }
  [data-gp-motion][data-gp-motion-state="open"] {
    opacity: 1;
    transform: none;
    pointer-events: auto;
    transition-duration: var(--gp-motion-open);
  }
  [data-gp-motion="modal"][data-gp-motion-state="open"] > [data-gp-motion-surface] {
    transform: none;
    transition-duration: var(--gp-motion-open);
  }
  [data-gp-motion="menu"][data-gp-motion-state="closed"] { transform: scale(.99); }
  /* 保持固定定位子菜单相对于视口定位，父菜单仅淡入淡出。 */
  [data-gp-motion][data-gp-motion-fixed-children] { transform: none; }
  [data-gp-motion][data-gp-motion-instant],
  [data-gp-motion][data-gp-motion-instant] > [data-gp-motion-surface] {
    transition: none !important;
    transform: none !important;
  }
  [data-gp-press] {
    transition: transform 120ms var(--gp-motion-ease),
      opacity var(--gp-transition, .18s ease), background-color var(--gp-transition, .18s ease),
      border-color var(--gp-transition, .18s ease), color var(--gp-transition, .18s ease);
  }
  [data-gp-press][data-gp-pressing]:not(:disabled) { transform: scale(.97); }
  @media (prefers-reduced-motion: reduce) {
    [data-gp-motion], [data-gp-motion] > [data-gp-motion-surface], [data-gp-press] {
      transition: none !important;
      transform: none !important;
    }
  }
`;

export function installMotionStyles(element: HTMLElement) {
  const root = element.getRootNode() as Document | ShadowRoot;
  if (root.querySelector('style[data-gp="motion"]')) return;
  const style = document.createElement('style');
  style.dataset.gp = 'motion';
  style.textContent = styles;
  (root instanceof Document ? root.head : root).appendChild(style);
}

export function showSurface(
  element: HTMLElement,
  kind: SurfaceKind,
  display = 'block',
  position?: () => void
) {
  installMotionStyles(element);
  const state = surfaces.get(element) || {};
  window.clearTimeout(state.timer);
  state.timer = undefined;
  surfaces.set(element, state);
  element.dataset.gpMotion = kind;
  element.toggleAttribute('data-gp-motion-instant', keyboardInput);
  const hidden = !element.dataset.gpMotionState || element.style.display === 'none';
  if (hidden) delete element.dataset.gpMotionState;
  element.style.display = display;
  position?.();
  // 只在重新挂载时提交起始样式；中途反向开合由 transition 从当前帧接续。
  if (hidden) void element.offsetWidth;
  element.inert = false;
  element.dataset.gpMotionState = 'open';
}

export function hideSurface(element: HTMLElement, onHidden?: () => void) {
  const state = surfaces.get(element);
  if (!state) {
    element.style.display = 'none';
    onHidden?.();
    return;
  }
  if (element.style.display === 'none') return;
  if (element.dataset.gpMotionState === 'closed') return;
  element.toggleAttribute('data-gp-motion-instant', keyboardInput);
  element.dataset.gpMotionState = 'closed';
  if (element.dataset.gpMotion !== 'toast') element.inert = true;
  const duration = Math.max(...getComputedStyle(element).transitionDuration.split(',').map((value) =>
    parseFloat(value) * (value.trim().endsWith('ms') ? 1 : 1000)
  ));
  const finish = () => {
    state.timer = undefined;
    element.style.display = 'none';
    onHidden?.();
  };
  if (duration > 0) state.timer = window.setTimeout(finish, duration);
  else finish();
}

export function setSurfaceOrigin(element: HTMLElement, anchor: DOMRect, left: number, top: number) {
  const x = Math.max(0, Math.min(anchor.left + anchor.width / 2 - left, element.offsetWidth));
  const y = Math.max(0, Math.min(anchor.top + anchor.height / 2 - top, element.offsetHeight));
  element.style.transformOrigin = `${Math.round(x)}px ${Math.round(y)}px`;
}
