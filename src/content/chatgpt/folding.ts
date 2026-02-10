export function initFolding() {
  const style = document.createElement('style');
  style.textContent = `
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
      border: 1px solid rgba(0,0,0,0.15);
      background: rgba(255,255,255,0.95);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #333;
      transition: all 0.2s ease;
      z-index: 100;
      box-shadow: 0 2px 6px rgba(0,0,0,0.15);
    }
    .gemini-project-toggle-btn:hover {
      background: #fff;
      box-shadow: 0 2px 5px rgba(0,0,0,0.1);
      transform: scale(1.1);
    }
    
    @media (prefers-color-scheme: dark) {
      .gemini-project-toggle-btn {
        background: rgba(70,70,75,0.95);
        border-color: rgba(255,255,255,0.2);
        color: #fff;
        box-shadow: 0 2px 6px rgba(0,0,0,0.4);
      }
      .gemini-project-toggle-btn:hover {
        background: rgba(90,90,95,1);
        box-shadow: 0 4px 10px rgba(0,0,0,0.5);
      }
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
