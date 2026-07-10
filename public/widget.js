(async function () {
    // ── Prevent Duplicate Initialization ─────────────────────────────────────
    if (document.getElementById('cc-widget-bubble') || document.getElementById('cc-widget-window')) {
        return;
    }

    const scriptTag  = document.currentScript;
    const businessId = scriptTag?.getAttribute('data-business-id');

    if (!businessId) {
        console.error('Comex AI Widget Error: Missing data-business-id attribute.');
        return;
    }

    // ── Session State ────────────────────────────────────────────────────────
    let chatHistory    = [];
    let isSending      = false;
    const conversationId = `conv-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // ── Default Configuration ────────────────────────────────────────────────
    let config = {
        name: 'AI Assistant',
        position: 'bottom-right',
        logoBase64: null,
        designConfig: {
            themeColor:      '#0f172a',
            typebarSize:     'standard',
            sendButtonStyle: 'icon',
            loadingAnim:      'dots',
            voiceEnabled:    false
        }
    };

    try {
        const r = await fetch(`https://comex-backend.vercel.app/api/config?businessId=${encodeURIComponent(businessId)}`);
        if (r.ok) {
            const result = await r.json();
            if (result.success) {
                config.name        = result.name        || config.name;
                config.position    = result.position    || config.position;
                config.logoBase64  = result.logoBase64  || config.logoBase64;
                config.designConfig = { ...config.designConfig, ...(result.designConfig || {}) };
            }
        }
    } catch (err) {
        console.warn('Comex Widget: Could not fetch config, using defaults.', err);
    }

    const { themeColor, typebarSize, sendButtonStyle, loadingAnim, voiceEnabled } = config.designConfig;

    // ── Position Computations ────────────────────────────────────────────────
    const positions = {
        'bottom-right': { bubble: 'bottom:32px; right:32px;', window: 'bottom:108px; right:32px; transform-origin: bottom right;' },
        'bottom-left':  { bubble: 'bottom:32px; left:32px;',  window: 'bottom:108px; left:32px; transform-origin: bottom left;'  },
        'top-right':    { bubble: 'top:32px; right:32px;',    window: 'top:108px; right:32px; transform-origin: top right;'     },
        'top-left':     { bubble: 'top:32px; left:32px;',     window: 'top:108px; left:32px; transform-origin: top left;'      }
    };
    const pos = positions[config.position] || positions['bottom-right'];

    // ── Inject Premium Styles ────────────────────────────────────────────────
    const style = document.createElement('style');
    style.textContent = `
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
        
        #cc-widget-bubble {
            position: fixed; ${pos.bubble}
            width: 64px; height: 64px; background-color: ${themeColor};
            border-radius: 50%; display: flex; align-items: center; justify-content: center;
            cursor: pointer; box-shadow: 0 12px 40px -4px rgba(0,0,0,0.25), inset 0 2px 4px rgba(255,255,255,0.2);
            transition: transform 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275), box-shadow 0.3s; z-index: 999999;
            user-select: none; color: #fff; background-size: cover; background-position: center;
            border: 1px solid rgba(255,255,255,0.1); will-change: transform;
        }
        #cc-widget-bubble:hover { transform: scale(1.06) translateY(-3px); box-shadow: 0 20px 48px -4px rgba(0,0,0,0.3); }
        #cc-widget-bubble:active { transform: scale(0.95); }
        #cc-widget-bubble svg { width: 28px; height: 28px; fill: currentColor; transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); }
        #cc-widget-bubble:hover svg { transform: rotate(-8deg) scale(1.05); }
        
        #cc-widget-window {
            position: fixed; ${pos.window}
            width: 400px; height: 640px; background: #ffffff;
            border: 1px solid rgba(226, 232, 240, 0.8); border-radius: 24px; display: none;
            flex-direction: column; overflow: hidden; box-shadow: 0 24px 60px -12px rgba(15, 23, 42, 0.18);
            z-index: 999999; font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            color: #0f172a; will-change: transform, opacity; opacity: 0;
            transition: opacity 0.25s ease, transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        #cc-widget-window.cc-open { display: flex; opacity: 1; transform: scale(1) translateY(0); }
        #cc-widget-window.cc-closed { transform: scale(0.85) translateY(30px); opacity: 0; }
        
        .cc-header {
            padding: 20px 24px; background: ${themeColor}; color: #fff;
            display: flex; align-items: center; justify-content: space-between;
            flex-shrink: 0; position: relative; overflow: hidden;
            box-shadow: 0 4px 20px rgba(0,0,0,0.04);
        }
        .cc-header::before {
            content: ''; position: absolute; top: -50%; left: -50%; width: 200%; height: 200%;
            background: radial-gradient(circle, rgba(255,255,255,0.08) 0%, transparent 70%); pointer-events: none;
        }
        .cc-header-left { display: flex; align-items: center; gap: 14px; position: relative; z-index: 1; }
        .cc-avatar-container { position: relative; }
        .cc-avatar {
            width: 42px; height: 42px; border-radius: 50%;
            background: rgba(255,255,255,0.12); border: 1px solid rgba(255,255,255,0.25);
            display: flex; align-items: center; justify-content: center; color: #fff; flex-shrink: 0;
            box-shadow: 0 4px 12px rgba(0,0,0,0.1);
        }
        .cc-avatar svg { width: 22px; height: 22px; fill: currentColor; }
        .cc-status-dot {
            width: 11px; height: 11px; background: #10b981; border: 2px solid ${themeColor};
            border-radius: 50%; position: absolute; bottom: 0; right: 0;
        }
        .cc-status-dot::after {
            content: ''; position: absolute; width: 100%; height: 100%; background: inherit;
            border-radius: inherit; left: -2px; top: -2px; border: 2px solid transparent; animation: ccPulseGreen 2.2s infinite;
        }
        @keyframes ccPulseGreen { 0% { transform: scale(1); opacity: 1; } 100% { transform: scale(2.8); opacity: 0; } }
        
        .cc-bot-title { font-weight: 600; font-size: 16px; letter-spacing: -0.01em; margin-bottom: 2px; }
        .cc-bot-status { font-size: 12px; opacity: 0.85; font-weight: 400; display: flex; align-items: center; gap: 4px; }
        
        .cc-close-btn {
            background: rgba(255, 255, 255, 0); border: none; color: #fff; opacity: 0.8;
            transition: all 0.2s; cursor: pointer; width: 34px; height: 34px; border-radius: 50%;
            display: flex; align-items: center; justify-content: center; position: relative; z-index: 1;
        }
        .cc-close-btn:hover { opacity: 1; background: rgba(255,255,255,0.15); transform: scale(1.05); }
        .cc-close-btn svg { width: 16px; height: 16px; stroke: currentColor; }
        
        .cc-chatbox {
            flex: 1; padding: 24px; overflow-y: auto; display: flex;
            flex-direction: column; gap: 16px; background: #f8fafc; scroll-behavior: smooth;
        }
        .cc-chatbox::-webkit-scrollbar { width: 6px; }
        .cc-chatbox::-webkit-scrollbar-track { background: transparent; }
        .cc-chatbox::-webkit-scrollbar-thumb { background: #e2e8f0; border-radius: 10px; }
        .cc-chatbox::-webkit-scrollbar-thumb:hover { background: #cbd5e1; }
        
        .cc-welcome-card {
            background: #fff; border: 1px solid #e2e8f0; border-radius: 16px;
            padding: 20px; text-align: center; margin-bottom: 8px;
            box-shadow: 0 4px 12px rgba(15,23,42,0.02);
        }
        .cc-welcome-card p { margin: 0 0 14px 0; font-size: 14px; color: #475569; line-height: 1.5; }
        .cc-suggested-grid { display: flex; flex-direction: column; gap: 8px; }
        .cc-suggested-chip {
            background: #f1f5f9; border: 1px solid #e2e8f0; padding: 10px 14px;
            border-radius: 10px; font-size: 13px; color: #334155; text-align: left;
            cursor: pointer; transition: all 0.2s ease; font-weight: 500;
        }
        .cc-suggested-chip:hover { background: ${themeColor}; color: #fff; border-color: ${themeColor}; transform: translateY(-1px); }

        .cc-bubble-container { display: flex; flex-direction: column; width: 100%; animation: ccFadeIn 0.3s ease forwards; }
        @keyframes ccFadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        
        .cc-bubble {
            max-width: 82%; padding: 12px 18px; border-radius: 18px;
            font-size: 14.5px; line-height: 1.55; word-break: break-word;
            box-shadow: 0 2px 4px rgba(15,23,42,0.01);
        }
        .cc-bubble p { margin: 0 0 8px 0; }
        .cc-bubble p:last-child { margin-bottom: 0; }
        .cc-bubble strong { font-weight: 600; }
        .cc-bubble ul, .cc-bubble ol { margin: 6px 0; padding-left: 20px; }
        .cc-bubble code { background: rgba(0,0,0,0.06); padding: 2px 5px; border-radius: 4px; font-family: monospace; font-size: 12.5px; }
        .cc-user .cc-bubble code { background: rgba(255,255,255,0.2); }
        
        .cc-user { align-items: flex-end; }
        .cc-user .cc-bubble {
            background: ${themeColor}; color: #fff; border-bottom-right-radius: 4px;
            box-shadow: 0 4px 14px -2px rgba(0,0,0,0.1);
        }
        .cc-ai { align-items: flex-start; }
        .cc-ai .cc-bubble {
            background: #ffffff; color: #1e293b; border-bottom-left-radius: 4px;
            border: 1px solid rgba(226,232,240,0.7); box-shadow: 0 4px 12px -2px rgba(15,23,42,0.04);
        }
        .cc-meta { font-size: 11px; color: #94a3b8; margin-top: 5px; padding: 0 4px; }
        
        .cc-footer {
            padding: 16px 20px; background: #ffffff; border-top: 1px solid #f1f5f9;
            display: flex; gap: 12px; align-items: center; flex-shrink: 0;
        }
        .cc-input-wrapper { flex: 1; position: relative; display: flex; align-items: center; }
        .cc-input {
            width: 100%; background: #f8fafc; border: 1.5px solid #e2e8f0;
            color: #0f172a; outline: none; font-family: inherit;
            padding: ${typebarSize === 'large' ? '14px 44px 14px 16px' : '12px 44px 12px 16px'};
            font-size: 14.5px; border-radius: 14px; transition: all 0.25s ease;
        }
        .cc-input:focus { border-color: ${themeColor}; background-color: #fff; box-shadow: 0 0 0 4px rgba(15,23,42,0.06); }
        
        .cc-send-btn {
            background: ${themeColor}; border: none; color: #fff;
            cursor: pointer; display: flex; align-items: center; justify-content: center;
            padding: ${sendButtonStyle === 'pill' ? '0 22px' : '0'};
            width: ${sendButtonStyle === 'pill' ? 'auto' : '46px'};
            height: 46px; border-radius: ${sendButtonStyle === 'pill' ? '23px' : '14px'};
            transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1); flex-shrink: 0;
            box-shadow: 0 4px 12px rgba(0,0,0,0.05);
        }
        .cc-send-btn svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
        .cc-send-btn:hover:not(:disabled) { opacity: 0.95; transform: scale(1.02) translateY(-1px); box-shadow: 0 6px 16px rgba(0,0,0,0.1); }
        .cc-send-btn:active:not(:disabled) { transform: scale(0.98); }
        .cc-send-btn:disabled { opacity: 0.35; cursor: not-allowed; transform: none; box-shadow: none; }
        
        .cc-mic-btn {
            position: absolute; right: 12px; background: none; border: none; color: #64748b;
            cursor: pointer; padding: 6px; display: ${voiceEnabled ? 'flex' : 'none'};
            align-items: center; justify-content: center; border-radius: 50%; transition: all 0.2s;
        }
        .cc-mic-btn:hover { color: #0f172a; background-color: #e2e8f0; }
        .cc-mic-btn svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2; }
        .cc-mic-btn.recording { color: #ef4444; background-color: #fef2f2; animation: ccPulse 1.4s infinite cubic-bezier(0.4, 0, 0.6, 1); }
        @keyframes ccPulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.12); } }
        
        .cc-typing {
            display: none; align-self: flex-start; background: #fff; border: 1px solid rgba(226,232,240,0.7);
            padding: 14px 20px; border-radius: 18px; border-bottom-left-radius: 4px;
            gap: 6px; align-items: center; box-shadow: 0 4px 12px rgba(15,23,42,0.03);
        }
        .cc-typing.visible { display: flex; }
        .cc-dot { width: 7px; height: 7px; border-radius: 50%; background: #94a3b8; animation: ccBounce 1.4s ease-in-out infinite; }
        .cc-dot:nth-child(2) { animation-delay: 0.2s; }
        .cc-dot:nth-child(3) { animation-delay: 0.4s; }
        @keyframes ccBounce { 0%,80%,100% { transform: translateY(0); } 40% { transform: translateY(-6px); } }

        .cc-brand-footer { text-align: center; font-size: 11px; color: #94a3b8; padding: 0 0 12px 0; background: #fff; font-weight: 500; }
        .cc-brand-footer a { color: #64748b; text-decoration: none; font-weight: 600; }
        
        @media (max-width: 480px) {
            #cc-widget-window {
                width: 100% !important; height: 100% !important;
                bottom: 0 !important; right: 0 !important; left: 0 !important; top: 0 !important;
                border-radius: 0 !important; transform: none !important;
            }
            #cc-widget-bubble { display: flex; }
            #cc-widget-window.cc-open { transform: none; }
        }
    `;
    document.head.appendChild(style);

    // ── Build Interactive Floating Bubble ────────────────────────────────────
    const bubble = document.createElement('div');
    bubble.id = 'cc-widget-bubble';
    if (config.logoBase64) {
        bubble.style.backgroundImage = `url('${config.logoBase64}')`;
    } else {
        bubble.innerHTML = `<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/></svg>`;
    }
    document.body.appendChild(bubble);

    // ── Build Main Window Framework ──────────────────────────────────────────
    const win = document.createElement('div');
    win.id = 'cc-widget-window';
    win.className = 'cc-closed';

    // Header Element
    const header = document.createElement('div');
    header.className = 'cc-header';
    const headerLeft = document.createElement('div');
    headerLeft.className = 'cc-header-left';
    
    const avatarContainer = document.createElement('div');
    avatarContainer.className = 'cc-avatar-container';
    const avatar = document.createElement('div');
    avatar.className = 'cc-avatar';
    avatar.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 2c-4.97 0-9 4.03-9 9 0 2.12.74 4.07 1.97 5.61L4.35 19.4c-.39.39-.39 1.02 0 1.41.39.39 1.02.39 1.41 0l2.79-2.79C10.09 18.64 11.03 19 12 19c4.97 0 9-4.03 9-9s-4.03-9-9-9zm0 15c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6-2.69 6-6 6zm-2-7c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm4 0c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm-4 4h4c.55 0 1-.45 1-1s-.45-1-1-1h-4c-.55 0-1 .45-1 1s.45 1 1 1z"/></svg>`;
    const statusDot = document.createElement('span');
    statusDot.className = 'cc-status-dot';
    avatarContainer.appendChild(avatar);
    avatarContainer.appendChild(statusDot);
    
    const headerInfo = document.createElement('div');
    const botNameEl = document.createElement('div');
    botNameEl.className = 'cc-bot-title';
    botNameEl.textContent = config.name;
    const statusEl = document.createElement('div');
    statusEl.className = 'cc-bot-status';
    statusEl.textContent = 'Replies instantly';
    headerInfo.appendChild(botNameEl);
    headerInfo.appendChild(statusEl);
    
    headerLeft.appendChild(avatarContainer);
    headerLeft.appendChild(headerInfo);
    
    const closeBtn = document.createElement('button');
    closeBtn.className = 'cc-close-btn';
    closeBtn.setAttribute('aria-label', 'Close chat');
    closeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    header.appendChild(headerLeft);
    header.appendChild(closeBtn);
    win.appendChild(header);

    // Chat Scroller Compartment
    const chatBox = document.createElement('div');
    chatBox.className = 'cc-chatbox';
    chatBox.id = 'ccChatBox';
    win.appendChild(chatBox);

    // Dynamic Context Native Onboarding Card
    const welcomeCard = document.createElement('div');
    welcomeCard.className = 'cc-welcome-card';
    welcomeCard.innerHTML = `
        <p>Hello! Welcome to our automated support helper. Choose a quick question below or type your inquiry natively.</p>
        <div class="cc-suggested-grid">
            <div class="cc-suggested-chip" data-msg="What services do you offer?"><img src="https://github.com/NewComet-Official/comex-backend/blob/main/ask_services.png" width="35" height="35"> What services do you offer?</div>
            <div class="cc-suggested-chip" data-msg="Speak to human support"><img src="https://github.com/NewComet-Official/comex-backend/blob/main/connect_human.png" width="35" height="35">
 Connect to human agent</div>
        </div>
    `;
    chatBox.appendChild(welcomeCard);

    // Animated Typing Engine Anchor
    const typingEl = document.createElement('div');
    typingEl.className = 'cc-typing';
    typingEl.id = 'ccTyping';
    typingEl.innerHTML = '<div class="cc-dot"></div><div class="cc-dot"></div><div class="cc-dot"></div>';
    chatBox.appendChild(typingEl);

    // Interactive Widget Footer Element
    const footer = document.createElement('div');
    footer.className = 'cc-footer';
    
    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'cc-input-wrapper';
    
    const inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.className = 'cc-input';
    inputEl.id = 'ccInput';
    inputEl.placeholder = 'Type a message…';
    inputEl.setAttribute('autocomplete', 'off');
    
    const micBtn = document.createElement('button');
    micBtn.className = 'cc-mic-btn';
    micBtn.id = 'ccMicBtn';
    micBtn.setAttribute('aria-label', 'Voice input');
    micBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 19v3M8 22h8"/></svg>`;
    
    inputWrapper.appendChild(inputEl);
    inputWrapper.appendChild(micBtn);
    
    const sendBtn = document.createElement('button');
    sendBtn.className = 'cc-send-btn';
    sendBtn.id = 'ccSendBtn';
    sendBtn.setAttribute('aria-label', 'Send message');
    if (sendButtonStyle === 'pill') {
        sendBtn.textContent = 'Send';
    } else {
        sendBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`;
    }
    
    footer.appendChild(inputWrapper);
    footer.appendChild(sendBtn);
    win.appendChild(footer);

    // White label branding link
    const brandFooter = document.createElement('div');
    brandFooter.className = 'cc-brand-footer';
    brandFooter.innerHTML = 'Powered by <a href="#" target="_blank">Comex AI</a>';
    win.appendChild(brandFooter);

    document.body.appendChild(win);

    // ── Ultra-Clean Sanitized Markdown Message Parser ─────────────────────────
    function parseMarkdown(text) {
        let clean = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        
        // Bold parsing
        clean = clean.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        // Inline Code parsing
        clean = clean.replace(/`(.*?)`/g, '<code>$1</code>');
        // Paragraph formatting lines
        return clean.split('\n').map(line => line.trim() ? `<p>${line}</p>` : '').join('');
    }

    function appendMsg(text, isUser) {
        const container = document.createElement('div');
        container.className = `cc-bubble-container ${isUser ? 'cc-user' : 'cc-ai'}`;
        
        const bubbleEl = document.createElement('div');
        bubbleEl.className = 'cc-bubble';
        
        if (isUser) {
            bubbleEl.textContent = text;
        } else {
            bubbleEl.innerHTML = parseMarkdown(text);
        }
        
        const timeEl = document.createElement('div');
        timeEl.className = 'cc-meta';
        const now = new Date();
        timeEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        
        container.appendChild(bubbleEl);
        container.appendChild(timeEl);
        
        chatBox.insertBefore(container, typingEl);
        chatBox.scrollTop = chatBox.scrollHeight;
        return container;
    }

    // Initialize Global Interactive Handlers
    function openWidget() {
        win.style.display = 'flex';
        setTimeout(() => {
            win.className = 'cc-open';
            inputEl.focus();
        }, 10);
    }

    function closeWidget() {
        win.className = 'cc-closed';
        setTimeout(() => { win.style.display = 'none'; }, 250);
    }

    bubble.addEventListener('click', () => {
        if (win.classList.contains('cc-open')) {
            closeWidget();
        } else {
            openWidget();
        }
    });
    
    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeWidget();
    });

    // ── Onboarding Suggestion Setup ──────────────────────────────────────────
    win.querySelectorAll('.cc-suggested-chip').forEach(chip => {
        chip.addEventListener('click', () => {
            inputEl.value = chip.getAttribute('data-msg');
            sendMessage();
            welcomeCard.style.display = 'none';
        });
    });

    // ── Core Async Transmission Controller ────────────────────────────────────
    async function sendMessage() {
        const text = inputEl.value.trim();
        if (!text || isSending) return;

        isSending = true;
        sendBtn.disabled = true;
        inputEl.value = '';
        welcomeCard.style.display = 'none';
        
        appendMsg(text, true);
        chatHistory.push({ role: 'user', content: text });

        typingEl.classList.add('visible');
        chatBox.scrollTop = chatBox.scrollHeight;

        try {
            const r = await fetch('https://comex-backend.vercel.app/api/chat', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    businessId,
                    message: text,
                    conversationId,
                    history: chatHistory.slice(-10)
                })
            });

            typingEl.classList.remove('visible');

            if (!r.ok) {
                appendMsg('Sorry, something went wrong. Please try again.', false);
                return;
            }

            const data  = await r.json();
            const reply = data.answer || data.reply || "Sorry, I couldn't process that.";
            appendMsg(reply, false);
            chatHistory.push({ role: 'assistant', content: reply });

        } catch (err) {
            typingEl.classList.remove('visible');
            appendMsg('Connection interrupted. Please try again.', false);
        } finally {
            isSending    = false;
            sendBtn.disabled = false;
            inputEl.focus();
        }
    }

    sendBtn.addEventListener('click', sendMessage);
    inputEl.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });

    // ── Native Speech Webkit Recognition Bridge ──────────────────────────────
    if (voiceEnabled) {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (SR) {
            const recognition = new SR();
            recognition.lang  = 'en-US';
            recognition.interimResults = false;
            let isRecording = false;

            micBtn.addEventListener('click', () => {
                if (isRecording) {
                    recognition.stop();
                } else {
                    micBtn.classList.add('recording');
                    isRecording = true;
                    recognition.start();
                }
            });
            recognition.onresult = e => {
                inputEl.value = e.results[0][0].transcript;
                micBtn.classList.remove('recording');
                isRecording = false;
                sendMessage();
            };
            recognition.onerror = recognition.onend = () => {
                micBtn.classList.remove('recording');
                isRecording = false;
            };
        }
    }
})();
