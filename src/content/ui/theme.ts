export type GeminiTheme = 'light' | 'dark';

// 统一判断 Gemini 站内深浅主题，避免仅依赖系统 prefers-color-scheme 导致错位。
export function resolveGeminiTheme(): GeminiTheme {
  const html = document.documentElement;
  const body = document.body;
  const classes = `${html?.className || ''} ${body?.className || ''}`.toLowerCase();
  const dataTheme = `${html?.getAttribute('data-theme') || ''} ${body?.getAttribute('data-theme') || ''}`.toLowerCase();

  if (/\b(light|theme-light|light-theme)\b/.test(`${classes} ${dataTheme}`)) {
    return 'light';
  }
  if (/\b(dark|theme-dark|dark-theme)\b/.test(`${classes} ${dataTheme}`)) {
    return 'dark';
  }

  const sample = [body, html]
    .map((node) => (node ? window.getComputedStyle(node).backgroundColor : ''))
    .find((color) => color && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)');
  if (!sample) return 'light';

  const rgb = sample.match(/\d+(\.\d+)?/g);
  if (!rgb || rgb.length < 3) return 'light';
  const [r, g, b] = rgb.slice(0, 3).map(Number);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance < 0.45 ? 'dark' : 'light';
}

export function observeGeminiTheme(onThemeChange: (theme: GeminiTheme) => void): () => void {
  let lastTheme: GeminiTheme | null = null;
  const sync = () => {
    const next = resolveGeminiTheme();
    if (next !== lastTheme) {
      lastTheme = next;
      onThemeChange(next);
    }
  };

  const observer = new MutationObserver(sync);
  const options: MutationObserverInit = {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-theme']
  };
  if (document.documentElement) {
    observer.observe(document.documentElement, options);
  }
  if (document.body) {
    observer.observe(document.body, options);
  }

  sync();
  return () => observer.disconnect();
}
