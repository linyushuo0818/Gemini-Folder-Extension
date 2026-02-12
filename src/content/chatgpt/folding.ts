export function initFolding() {
  const style = document.createElement('style');
  style.textContent = `
    :root {
      --gp-folding-btn-bg: rgba(245, 242, 234, 0.95);
      --gp-folding-btn-bg-hover: rgba(251, 250, 246, 0.98);
      --gp-folding-btn-border: rgba(91, 89, 84, 0.16);
      --gp-folding-btn-fg: rgba(27, 26, 24, 0.92);
      --gp-folding-btn-shadow: 0 2px 6px rgba(27, 26, 24, 0.16);
      --gp-folding-btn-shadow-hover: 0 4px 10px rgba(27, 26, 24, 0.22);
      --gp-folding-transition: .18s ease;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --gp-folding-btn-bg: rgba(35, 33, 30, 0.95);
        --gp-folding-btn-bg-hover: rgba(46, 43, 40, 0.98);
        --gp-folding-btn-border: rgba(237, 233, 224, 0.18);
        --gp-folding-btn-fg: rgba(237, 233, 224, 0.92);
        --gp-folding-btn-shadow: 0 2px 6px rgba(0, 0, 0, 0.42);
        --gp-folding-btn-shadow-hover: 0 4px 10px rgba(0, 0, 0, 0.5);
      }
    }

    .gemini-project-folded {
      max-height: 150px;
      overflow: hidden;
      mask-image: linear-gradient(to bottom, black 60%, transparent 100%);
      -webkit-mask-image: linear-gradient(to bottom, black 60%, transparent 100%);
    }
    .gemini-project-relative {
      position: relative !important;
      padding-right: 30px !important; /* Make space for the button */
    }
    .gemini-project-toggle-btn {
      position: absolute;
      top: 8px;
      right: 8px;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      border: 1px solid var(--gp-folding-btn-border);
      background: var(--gp-folding-btn-bg);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--gp-folding-btn-fg);
      transition: background var(--gp-folding-transition), box-shadow var(--gp-folding-transition), transform var(--gp-folding-transition);
      z-index: 100;
      box-shadow: var(--gp-folding-btn-shadow);
    }
    .gemini-project-toggle-btn:hover {
      background: var(--gp-folding-btn-bg-hover);
      box-shadow: var(--gp-folding-btn-shadow-hover);
      transform: translateY(-1px);
    }
  `;
  document.head.appendChild(style);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'childList') {
        processMessages();
      }
    }
  });

  const chatContainer = document.querySelector('main');
  if (chatContainer) {
    observer.observe(chatContainer, { childList: true, subtree: true });
  } else {
    // Fallback: observe body if main is not yet available
    observer.observe(document.body, { childList: true, subtree: true });
  }

  processMessages();
}

function processMessages() {
  // Selector for user messages in ChatGPT
  // Note: ChatGPT selectors change frequently. 
  // currently looking for user messages which often have [data-message-author-role="user"]
  const userMessages = document.querySelectorAll('[data-message-author-role="user"]');

  userMessages.forEach((msg) => {
    // Avoid re-processing
    if (msg.hasAttribute('data-gemini-project-processed')) return;

    // The actual text content container is likely inside.
    // We aim to fold the text content, not the avatar or whole row.
    const contentDiv = msg.querySelector('.whitespace-pre-wrap') as HTMLElement;
    if (!contentDiv) return;

    // Check height
    if (contentDiv.clientHeight > 150) {
      msg.setAttribute('data-gemini-project-processed', 'true');

      // Setup relative positioning on the container
      contentDiv.classList.add('gemini-project-relative');
      contentDiv.classList.add('gemini-project-folded');

      // Create Toggle Button
      const btn = document.createElement('button');
      btn.className = 'gemini-project-toggle-btn';
      btn.title = 'Expand';
      btn.innerHTML = getChevronDownIcon();

      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();

        const isFolded = contentDiv.classList.contains('gemini-project-folded');
        if (isFolded) {
          contentDiv.classList.remove('gemini-project-folded');
          btn.innerHTML = getChevronUpIcon();
          btn.title = 'Collapse';
        } else {
          contentDiv.classList.add('gemini-project-folded');
          btn.innerHTML = getChevronDownIcon();
          btn.title = 'Expand';
        }
      };

      // Append button to the content container
      contentDiv.appendChild(btn);
    }
  });
}

function getChevronDownIcon() {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M6 9L12 15L18 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

function getChevronUpIcon() {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M18 15L12 9L6 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}
