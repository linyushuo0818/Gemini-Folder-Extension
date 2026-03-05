(function () {
  'use strict';

  if (window.__gpResponseFoldLiteLoaded) return;
  window.__gpResponseFoldLiteLoaded = true;
  if (window.location.hostname !== 'gemini.google.com') return;

  var STYLE_ID = 'gp-rf-lite-style';
  var BTN_CLASS = 'gp-rf-lite-btn';
  var HOST_CLASS = 'gp-rf-lite-host';
  var COLLAPSED_CLASS = 'gp-rf-lite-collapsed';
  var THINKING_HIDDEN_CLASS = 'gp-rf-lite-thinking-hidden';
  var BTN_COLLAPSED_CLASS = 'gp-rf-lite-btn-collapsed';

  var BTN_ATTR = 'data-gp-rf-btn';
  var HOST_ATTR = 'data-gp-rf-host';
  var KEY_ATTR = 'data-gp-rf-key';

  var FEATURE_ENABLED_KEY = 'gp_feature_response_folding_enabled';
  var FEATURE_DEBUG_HARD_DISABLE_KEY = 'gp_feature_response_folding_hard_disable';
  var FEATURE_TRIPPED_KEY = 'gp_feature_response_folding_tripped_lite_v3';
  var FOLDS_KEY = 'gp_gemini_response_folds_v5';

  var EXCLUDED_SELECTOR = '#gemini-projects-host, #gemini-projects-overlay, #gp-overlay-layer, #gp-prompt-picker-root, nav, aside';

  var ROOT_SELECTORS = [
    'main model-response',
    'main [data-message-author-role="model"]',
    'main [data-message-author-role="assistant"]',
    'main [data-test-id*="model-response"]',
    'main [data-testid*="model-response"]'
  ];

  var CONTENT_SELECTORS = [
    '.markdown',
    '[class*="markdown"]',
    '[class*="response-content"]',
    '[class*="message-content"]',
    '[data-testid*="content"]',
    '[data-test-id*="content"]',
    'article'
  ];

  var THINKING_TOKENS = [
    'show thinking',
    'thinking',
    'display reasoning',
    'show thought process',
    'show thoughts',
    '\u663e\u793a\u601d\u8003',
    '\u663e\u793a\u601d\u8def',
    '\u601d\u8def',
    '\u663e\u793a\u63a8\u7406',
    '\u63a8\u7406',
    '\u601d\u8003'
  ];

  var MIN_TEXT_LENGTH = 90;
  var MIN_COLLAPSIBLE_HEIGHT = 180;
  var MAX_SAVED_KEYS = 1200;
  var ERROR_THRESHOLD = 3;
  var SCAN_DEBOUNCE_MS = 240;
  var NUDGE_THINKING_X = 6;
  var NUDGE_DEFAULT_X = -10;
  var NUDGE_DEFAULT_Y = -10;

  var state = {
    initialized: false,
    tripped: false,
    errors: 0,
    foldSet: new Set(),
    observer: null,
    scanTimer: null,
    persistTimer: null,
    rootsByKey: new Map(),
    contentByKey: new Map(),
    thinkingBlockByKey: new Map(),
    buttonByKey: new Map(),
    hostByKey: new Map()
  };

  init();

  function init() {
    if (state.initialized || state.tripped) return;
    state.initialized = true;

    guarded('init', function () {
    return readGate().then(function (gate) {
        if (!gate.enabled || gate.tripped) return;
        ensureStyle();
        return loadFolds().then(function () {
          startObserver();
          scheduleScan();
        });
      });
    });
  }

  function guarded(stage, fn) {
    if (state.tripped) return;
    Promise.resolve()
      .then(fn)
      .then(function () {
        if (stage === 'scan') state.errors = 0;
      })
      .catch(function (err) {
        state.errors += 1;
        console.warn('[gp-rf-lite] ' + stage + ' failed', err);
        if (state.errors >= ERROR_THRESHOLD) {
          trip(stage, err);
        }
      });
  }

  function trip(stage, err) {
    if (state.tripped) return;
    state.tripped = true;
    stopObserver();
    cleanupAll();
    removeStyle();
    storageSet({ [FEATURE_TRIPPED_KEY]: true }).catch(function () {});
    console.error('[gp-rf-lite] circuit tripped at ' + stage, err);
  }

  function startObserver() {
    if (state.observer) return;

    var main = document.querySelector('main, [role="main"]') || document.body;
    state.observer = new MutationObserver(function () {
      scheduleScan();
    });

    state.observer.observe(main, {
      childList: true,
      subtree: true,
      characterData: false
    });

    window.addEventListener('resize', scheduleScan, { passive: true });
    window.addEventListener('popstate', scheduleScan);
    window.addEventListener('hashchange', scheduleScan);
  }

  function stopObserver() {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
    if (state.scanTimer !== null) {
      clearTimeout(state.scanTimer);
      state.scanTimer = null;
    }
    if (state.persistTimer !== null) {
      clearTimeout(state.persistTimer);
      state.persistTimer = null;
    }

    window.removeEventListener('resize', scheduleScan);
    window.removeEventListener('popstate', scheduleScan);
    window.removeEventListener('hashchange', scheduleScan);
  }

  function scheduleScan() {
    if (state.tripped || document.hidden) return;
    if (state.scanTimer !== null) return;

    state.scanTimer = setTimeout(function () {
      state.scanTimer = null;
      guarded('scan', scanAndRender);
    }, SCAN_DEBOUNCE_MS);
  }

  function scanAndRender() {
    var candidates = collectCandidates();
    var seen = new Set();

    candidates.forEach(function (c) {
      seen.add(c.key);

      var host = state.hostByKey.get(c.key);
      if (!host || !host.isConnected) {
        host = createHost();
      }

      var button = state.buttonByKey.get(c.key);
      if (!button || !button.isConnected) {
        button = createButton();
        host.appendChild(button);
      }

      placeHost(c, host);
      bindButton(button, c.key);

      state.rootsByKey.set(c.key, c.root);
      state.contentByKey.set(c.key, c.content);
      state.thinkingBlockByKey.set(c.key, resolveThinkingBlock(c.anchor, c.root));
      state.buttonByKey.set(c.key, button);
      state.hostByKey.set(c.key, host);

      c.root.setAttribute(KEY_ATTR, c.key);
      button.setAttribute(KEY_ATTR, c.key);

      var collapsed = state.foldSet.has(c.key);
      if (!collapsed && !isCollapsible(c.content)) {
        applyCollapsed(c.key, false);
        host.style.display = 'none';
      } else {
        host.style.display = '';
        applyCollapsed(c.key, collapsed);
      }
    });

    Array.from(state.rootsByKey.keys()).forEach(function (key) {
      if (!seen.has(key)) {
        cleanupKey(key);
      }
    });

    dedupeByDom();
  }

  function collectCandidates() {
    var main = document.querySelector('main, [role="main"]');
    if (!main || main.closest(EXCLUDED_SELECTOR)) return [];

    var roots = collectRoots(main);
    var out = [];
    var used = new Set();

    roots.forEach(function (root, index) {
      if (!isUsableRoot(root)) return;

      var anchor = findThinkingAnchor(root);
      var content = pickContent(root, anchor);
      if (!content) return;

      var key = deriveKey(root, content, index);
      if (!key || used.has(key)) return;
      used.add(key);

      out.push({ key: key, root: root, content: content, anchor: anchor });
    });

    return out;
  }

  function collectRoots(main) {
    var set = new Set();

    ROOT_SELECTORS.forEach(function (selector) {
      main.querySelectorAll(selector).forEach(function (el) {
        if (el instanceof HTMLElement) set.add(el);
      });
    });

    // Fast model fallback: if strict selectors miss, infer from action rows.
    if (set.size === 0) {
      var actionRows = main.querySelectorAll('button, [role="button"]');
      Array.from(actionRows).forEach(function (btn) {
        if (!(btn instanceof HTMLElement)) return;
        if (btn.closest(EXCLUDED_SELECTOR)) return;
        var label = normalize((btn.getAttribute('aria-label') || btn.textContent || '').toLowerCase());
        if (!label) return;
        var looksAction = label.includes('like') || label.includes('dislike') || label.includes('copy') || label.includes('\u590d\u5236') || label.includes('\u8d5e') || label.includes('\u8e29');
        if (!looksAction) return;
        var r = nearestRoot(btn, main);
        if (r) set.add(r);
      });
    }

    // Remove nested duplicates, keep outer roots.
    var arr = Array.from(set);
    return arr.filter(function (node) {
      return !arr.some(function (other) {
        return other !== node && other.contains(node);
      });
    });
  }

  function nearestRoot(el, main) {
    var cur = el;
    while (cur && cur !== main) {
      if (!(cur instanceof HTMLElement)) break;
      if (cur.closest(EXCLUDED_SELECTOR)) return null;
      if (isUserNode(cur)) return null;
      if (getLogicText(cur).length >= MIN_TEXT_LENGTH) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  function isUsableRoot(root) {
    if (!root || !root.isConnected) return false;
    if (!root.closest('main, [role="main"]')) return false;
    if (root.closest(EXCLUDED_SELECTOR)) return false;
    if (isUserNode(root)) return false;
    return true;
  }

  function isUserNode(node) {
    return !!node.closest('[data-message-author-role="user"], user-query, [class*="user-message"], [class*="user-query"]');
  }

  function findThinkingAnchor(root) {
    var nodes = root.querySelectorAll('button, [role="button"]');
    for (var i = 0; i < nodes.length; i += 1) {
      var el = nodes[i];
      if (!(el instanceof HTMLElement)) continue;
      var text = normalize((el.textContent || '').toLowerCase());
      if (!text) continue;
      var hit = THINKING_TOKENS.some(function (t) { return text.indexOf(t) >= 0; });
      if (hit) return el;
    }
    return null;
  }

  function pickContent(root, anchor) {
    var candidates = new Set();

    CONTENT_SELECTORS.forEach(function (selector) {
      root.querySelectorAll(selector).forEach(function (n) {
        if (n instanceof HTMLElement) candidates.add(n);
      });
    });

    if (!candidates.size) candidates.add(root);

    var best = null;
    var bestScore = -1;

    candidates.forEach(function (node) {
      if (!node.isConnected) return;
      if (node.closest(EXCLUDED_SELECTOR)) return;
      if (isUserNode(node)) return;
      if (node.querySelector('textarea, input, [contenteditable="true"]')) return;

      if (anchor && node.contains(anchor)) return;

      var len = getLogicText(node).length;
      if (len < MIN_TEXT_LENGTH) return;

      var bonus = 0;
      if (anchor && anchor.isConnected && root.contains(anchor)) {
        var pos = anchor.compareDocumentPosition(node);
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) bonus = 100000;
      }

      var score = len + bonus;
      if (score > bestScore) {
        bestScore = score;
        best = node;
      }
    });

    return best;
  }

  function deriveKey(root, content, index) {
    var conv = getConversationId(window.location.href) || 'gemini-home';
    var id = findStableId(root) || findStableId(content);
    if (id) return conv + '::id:' + id;
    return conv + '::idx:' + index;
  }

  function findStableId(start) {
    var attrs = ['data-message-id', 'data-response-id', 'data-turn-id', 'data-id', 'id'];
    var cur = start;

    for (var depth = 0; depth < 6 && cur; depth += 1) {
      for (var i = 0; i < attrs.length; i += 1) {
        var v = cur.getAttribute(attrs[i]);
        if (looksId(v)) return v;
      }
      cur = cur.parentElement;
    }

    return null;
  }

  function looksId(v) {
    return !!v && v.length >= 6 && !/\s/.test(v);
  }

  function createHost() {
    var host = document.createElement('div');
    host.className = HOST_CLASS;
    host.setAttribute(HOST_ATTR, '1');
    return host;
  }

  function createButton() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = BTN_CLASS;
    btn.setAttribute(BTN_ATTR, '1');
    btn.setAttribute('data-gp-rf-label', '');
    btn.setAttribute('data-gp-rf-collapsed', '0');
    return btn;
  }

  function placeHost(candidate, host) {
    var anchor = candidate.anchor;
    var content = candidate.content;

    if (anchor && anchor.isConnected) {
      var rowAnchor = anchor.closest('button, [role="button"]') || anchor;
      var rowBlock = rowAnchor.parentElement || rowAnchor;
      var rowParent = rowBlock.parentElement;
      if (rowParent) {
        if (host.parentElement !== rowParent || host.nextElementSibling !== rowBlock) {
          rowBlock.insertAdjacentElement('beforebegin', host);
        }
        var thinkingLabel = findThinkingLabelNode(rowAnchor) || rowAnchor;
        var thinkingOffset = computeLeftOffset(rowParent, thinkingLabel, 8, 180);
        host.setAttribute('data-gp-rf-placement', 'thinking-above');
        host.style.width = '100%';
        host.style.margin = '0 0 6px ' + thinkingOffset + 'px';
        host.style.marginLeft = '';
        host.style.justifyContent = 'flex-start';
        host.style.alignSelf = '';
        host.style.position = '';
        host.style.zIndex = '';
        host.style.transform = 'translateX(' + NUDGE_THINKING_X + 'px)';
        return;
      }
    }

    // Fast model fallback: place host at content top.
    if (content && content.parentElement) {
      if (host.parentElement !== content.parentElement || host.nextElementSibling !== content) {
        content.insertAdjacentElement('beforebegin', host);
      }
      var contentRef = findContentTextAnchor(content) || content;
      var contentOffset = computeLeftOffset(content.parentElement, contentRef, 24, 220);
      host.setAttribute('data-gp-rf-placement', 'content-top');
      host.style.width = '100%';
      host.style.margin = '6px 0 8px ' + contentOffset + 'px';
      host.style.marginLeft = '';
      host.style.justifyContent = 'flex-start';
      host.style.alignSelf = '';
      host.style.position = 'relative';
      host.style.zIndex = '1';
      host.style.transform = 'translate(' + NUDGE_DEFAULT_X + 'px, ' + NUDGE_DEFAULT_Y + 'px)';
      return;
    }

    if (host.parentElement !== candidate.root) {
      candidate.root.insertBefore(host, candidate.root.firstChild);
    }
    var rootRef = (content && findContentTextAnchor(content)) || content || candidate.root;
    var rootOffset = computeLeftOffset(candidate.root, rootRef, 24, 220);
    host.setAttribute('data-gp-rf-placement', 'root-top');
    host.style.width = '100%';
    host.style.margin = '6px 0 8px ' + rootOffset + 'px';
    host.style.marginLeft = '';
    host.style.justifyContent = 'flex-start';
    host.style.alignSelf = '';
    host.style.position = 'relative';
    host.style.zIndex = '1';
    host.style.transform = 'translate(' + NUDGE_DEFAULT_X + 'px, ' + NUDGE_DEFAULT_Y + 'px)';
  }

  function resolveThinkingBlock(anchor, root) {
    if (!anchor || !anchor.isConnected) return null;
    var rowAnchor = anchor.closest('button, [role="button"]') || anchor;
    var rowBlock = rowAnchor.parentElement || rowAnchor;
    if (!rowBlock || !(rowBlock instanceof HTMLElement)) return null;
    if (root && !root.contains(rowBlock)) return null;
    return rowBlock;
  }

  function findThinkingLabelNode(anchorButton) {
    if (!anchorButton || !(anchorButton instanceof HTMLElement)) return null;

    var specific = anchorButton.querySelector(
      '[class*="thoughts-header-button-content"], [class*="button-label"], [class*="animated-text"]'
    );
    if (specific instanceof HTMLElement) return specific;

    var nodes = anchorButton.querySelectorAll('span, div');
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      if (!(node instanceof HTMLElement)) continue;
      var txt = normalize(node.textContent || '');
      if (!txt) continue;
      var cs = window.getComputedStyle(node);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      return node;
    }
    return anchorButton;
  }

  function findContentTextAnchor(contentRoot) {
    if (!contentRoot || !(contentRoot instanceof HTMLElement)) return null;

    var selectors = [
      'p',
      'li',
      'h1, h2, h3, h4, h5, h6',
      'pre',
      'blockquote',
      '[class*="markdown"] p',
      '[class*="response-content"] p'
    ];

    for (var i = 0; i < selectors.length; i += 1) {
      var node = contentRoot.querySelector(selectors[i]);
      if (!(node instanceof HTMLElement)) continue;
      var txt = normalize(node.textContent || '');
      if (!txt) continue;
      var cs = window.getComputedStyle(node);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      return node;
    }

    var walker = document.createTreeWalker(contentRoot, NodeFilter.SHOW_ELEMENT);
    var cur = walker.currentNode;
    while (cur) {
      var el = cur;
      if (el instanceof HTMLElement) {
        var t = normalize(el.textContent || '');
        if (t.length >= 2) return el;
      }
      cur = walker.nextNode();
    }
    return null;
  }

  function computeLeftOffset(parent, reference, min, max) {
    if (!parent || !reference) return min;
    var parentRect = parent.getBoundingClientRect();
    var refRect = reference.getBoundingClientRect();
    var raw = Math.round(refRect.left - parentRect.left);
    if (!Number.isFinite(raw)) return min;
    return Math.max(min, Math.min(max, raw));
  }

  function bindButton(button, key) {
    if (button.__gpKey === key) return;
    button.__gpKey = key;

    button.onclick = function (ev) {
      ev.preventDefault();
      ev.stopPropagation();

      guarded('toggle', function () {
        var collapsed = state.foldSet.has(key);
        if (collapsed) state.foldSet.delete(key);
        else rememberKey(key);

        applyCollapsed(key, !collapsed);
        schedulePersist();
      });
    };
  }

  function applyCollapsed(key, collapsed) {
    var content = state.contentByKey.get(key);
    var thinkingBlock = state.thinkingBlockByKey.get(key);
    var button = state.buttonByKey.get(key);
    if (!content || !button) return;

    if (collapsed) {
      content.classList.add(COLLAPSED_CLASS);
      if (thinkingBlock && thinkingBlock.classList) thinkingBlock.classList.add(THINKING_HIDDEN_CLASS);
      button.classList.add(BTN_COLLAPSED_CLASS);
      button.setAttribute('data-gp-rf-label', 'Collapsed');
      button.setAttribute('data-gp-rf-collapsed', '1');
      button.title = 'Expand reply';
      button.setAttribute('aria-label', 'Expand reply');
      button.setAttribute('aria-expanded', 'false');
    } else {
      content.classList.remove(COLLAPSED_CLASS);
      if (thinkingBlock && thinkingBlock.classList) thinkingBlock.classList.remove(THINKING_HIDDEN_CLASS);
      button.classList.remove(BTN_COLLAPSED_CLASS);
      button.setAttribute('data-gp-rf-label', 'Collapse reply');
      button.setAttribute('data-gp-rf-collapsed', '0');
      button.title = 'Collapse reply';
      button.setAttribute('aria-label', 'Collapse reply');
      button.setAttribute('aria-expanded', 'true');
    }
  }

  function isCollapsible(content) {
    var textLen = getLogicText(content).length;
    if (textLen < MIN_TEXT_LENGTH) return false;

    var full = content.scrollHeight;
    var view = Math.max(content.clientHeight, Math.round(content.getBoundingClientRect().height));

    if (full <= 0) return false;
    if (view <= 0) return full > MIN_COLLAPSIBLE_HEIGHT;

    return full > MIN_COLLAPSIBLE_HEIGHT || full - view > 16;
  }

  function rememberKey(key) {
    if (state.foldSet.has(key)) state.foldSet.delete(key);
    state.foldSet.add(key);
    while (state.foldSet.size > MAX_SAVED_KEYS) {
      state.foldSet.delete(state.foldSet.values().next().value);
    }
  }

  function schedulePersist() {
    if (state.persistTimer !== null) clearTimeout(state.persistTimer);

    state.persistTimer = setTimeout(function () {
      state.persistTimer = null;
      guarded('persist', function () {
        var payload = {};
        state.foldSet.forEach(function (k) { payload[k] = 1; });
        return storageSet({ [FOLDS_KEY]: payload });
      });
    }, 150);
  }

  function cleanupKey(key) {
    var content = state.contentByKey.get(key);
    var thinkingBlock = state.thinkingBlockByKey.get(key);
    var button = state.buttonByKey.get(key);
    var host = state.hostByKey.get(key);
    var root = state.rootsByKey.get(key);

    if (content && content.classList) content.classList.remove(COLLAPSED_CLASS);
    if (thinkingBlock && thinkingBlock.classList) thinkingBlock.classList.remove(THINKING_HIDDEN_CLASS);
    if (button && button.isConnected) button.remove();
    if (host && host.isConnected) host.remove();
    if (root && root.getAttribute(KEY_ATTR) === key) root.removeAttribute(KEY_ATTR);

    state.contentByKey.delete(key);
    state.thinkingBlockByKey.delete(key);
    state.buttonByKey.delete(key);
    state.hostByKey.delete(key);
    state.rootsByKey.delete(key);
  }

  function cleanupAll() {
    Array.from(state.rootsByKey.keys()).forEach(cleanupKey);
  }

  function dedupeByDom() {
    var buttons = document.querySelectorAll('[' + BTN_ATTR + ']');
    var seen = new Set();
    Array.from(buttons).forEach(function (btn) {
      var key = btn.getAttribute(KEY_ATTR) || '';
      var id = key || ('__dom__' + btn.parentElement);
      if (seen.has(id)) {
        btn.remove();
      } else {
        seen.add(id);
      }
    });
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;

    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent =
      '.' + HOST_CLASS + '{display:flex;justify-content:flex-start;align-items:center;margin:4px 0 8px;pointer-events:auto;}' +
      '.' + BTN_CLASS + '{display:inline-flex;align-items:center;justify-content:center;height:36px;padding:0 14px;border-radius:999px;background:transparent;border:none;color:rgba(31,31,31,.92);font-family:\"Google Sans Flex\",\"Google Sans\",\"Helvetica Neue\",Arial,sans-serif;font-size:15px;font-weight:500;line-height:20px;letter-spacing:.01em;cursor:pointer;text-decoration:none;outline:none;white-space:nowrap;transition:background .15s ease,color .15s ease;}' +
      '.' + BTN_CLASS + '[data-gp-rf-label]::before{content:attr(data-gp-rf-label);}' +
      '.' + BTN_CLASS + '::after{content:\"expand_more\";margin-left:6px;font-family:\"Google Symbols\",\"Material Symbols Outlined\",\"Material Icons\",sans-serif;font-size:20px;font-weight:400;line-height:1;letter-spacing:normal;text-transform:none;direction:ltr;-webkit-font-smoothing:antialiased;font-feature-settings:\"liga\" 1;opacity:.92;}' +
      '.' + BTN_CLASS + '[data-gp-rf-collapsed=\"1\"]::after{content:\"chevron_right\";}' +
      '.' + BTN_CLASS + ':hover{background:rgba(211,227,253,.72);color:rgba(31,31,31,.92);text-decoration:none;}' +
      '.' + BTN_CLASS + ':focus-visible{background:rgba(211,227,253,.72);color:rgba(31,31,31,.92);box-shadow:none;}' +
      '.' + THINKING_HIDDEN_CLASS + '{display:none !important;}' +
      '.' + COLLAPSED_CLASS + '{max-height:0 !important;min-height:0 !important;overflow:hidden !important;margin:0 !important;padding-top:0 !important;padding-bottom:0 !important;border-top-width:0 !important;border-bottom-width:0 !important;opacity:0 !important;pointer-events:none !important;}';

    document.head.appendChild(style);
  }

  function removeStyle() {
    var style = document.getElementById(STYLE_ID);
    if (style) style.remove();
  }

  function readGate() {
    return storageGet([FEATURE_ENABLED_KEY, FEATURE_TRIPPED_KEY, FEATURE_DEBUG_HARD_DISABLE_KEY])
      .then(function (data) {
        var hardDisabled = data[FEATURE_DEBUG_HARD_DISABLE_KEY] === true;
        return {
          enabled: !hardDisabled && data[FEATURE_ENABLED_KEY] !== false,
          tripped: data[FEATURE_TRIPPED_KEY] === true
        };
      })
      .catch(function () {
        return { enabled: true, tripped: false };
      });
  }

  function loadFolds() {
    return storageGet(FOLDS_KEY)
      .then(function (data) {
        var raw = data[FOLDS_KEY];
        if (!raw || typeof raw !== 'object') {
          state.foldSet = new Set();
          return;
        }
        state.foldSet = new Set(Object.keys(raw));
      })
      .catch(function () {
        state.foldSet = new Set();
      });
  }

  function storageGet(keys) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.storage.local.get(keys, function (res) {
          if (chrome.runtime && chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || 'storage.get failed'));
            return;
          }
          resolve(res || {});
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  function storageSet(items) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.storage.local.set(items, function () {
          if (chrome.runtime && chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || 'storage.set failed'));
            return;
          }
          resolve();
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  function getConversationId(input) {
    try {
      var url = new URL(input, window.location.origin);
      var parts = url.pathname.split('/').filter(Boolean);
      var appIndex = parts.indexOf('app');
      if (appIndex >= 0 && parts.length > appIndex + 1) return parts[appIndex + 1];
      return url.searchParams.get('conversationId') || url.searchParams.get('conversation_id') || url.searchParams.get('id') || null;
    } catch (_) {
      return null;
    }
  }

  function normalize(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function getLogicText(node) {
    if (!node) return '';
    var clone = node.cloneNode(true);
    if (clone && clone.querySelectorAll) {
      clone.querySelectorAll('[' + BTN_ATTR + '], [' + HOST_ATTR + ']').forEach(function (el) { el.remove(); });
    }
    return normalize(clone.textContent || '');
  }
})();
