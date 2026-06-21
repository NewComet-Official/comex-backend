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

    // ── Session state ────────────────────────────────────────────────────────
    let chatHistory    = [];
    let isSending      = false;
    const conversationId = `conv-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // ── Default config ───────────────────────────────────────────────────────
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

    // ── Position styles ──────────────────────────────────────────────────────
    const positions = {
        'bottom-right': { bubble: 'bottom:25px;right:25px;',  window: 'bottom:100px;right:25px;'  },
        'bottom-left':  { bubble: 'bottom:25px;left:25px;',   window: 'bottom:100px;left:25px;'   },
        'top-right':    { bubble: 'top:25px;right:25px;',     window: 'top:100px;right:25px;'     },
        'top-left':     { bubble: 'top:25px;left:25px;',      window: 'top:100px;left:25px;'      }
    };
    const pos = positions[config.position] || positions['bottom-right'];

    // ── Inject styles ────────────────────────────────────────────────────────
    const style = document.createElement('style');
    style.textContent = `
        #cc-widget-bubble {
            position:fixed; ${pos.bubble}
            width:60px; height:60px; background-color:${themeColor};
            border-radius:50%; display:flex; align-items:center; justify-content:center;
            cursor:pointer; box-shadow:0 10px 30px -5px rgba(0,0,0,0.3);
            transition:transform 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275), box-shadow 0.25s; z-index:999999;
            user-select:none; color:#fff; background-size:cover;
            background-position:center; border:1px solid rgba(255,255,255,0.2);
            will-change:transform;
        }
        #cc-widget-bubble:hover { transform:scale(1.08) translateY(-2px); box-shadow:0 15px 35px -5px rgba(0,0,0,0.35); }
        #cc-widget-bubble svg { width: 26px; height: 26px; fill: currentColor; transition: transform 0.2s; }
        #cc-widget-bubble:hover svg { transform: rotate(5deg) scale(1.05); }
        
        #cc-widget-window {
            position:fixed; ${pos.window}
            width:380px; height:580px; background:#fff;
            border:1px solid #e5e7eb; border-radius:24px; display:none;
            flex-direction:column; overflow:hidden;
            box-shadow:0 20px 50px -12px rgba(0,0,0,0.15);
            z-index:999999; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
            color:#1f2937; will-change:transform, opacity;
            animation:ccSlideIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
        }
        @keyframes ccSlideIn { from{opacity:0;transform:translateY(20px) scale(0.95)} to{opacity:1;transform:none} }
        
        .cc-header {
            padding:18px 22px; background:${themeColor}; color:#fff;
            font-weight:600; font-size:16px; letter-spacing: -0.01em;
            display:flex; align-items:center; justify-content:space-between;
            flex-shrink:0; box-shadow: 0 4px 20px rgba(0,0,0,0.05);
        }
        .cc-header-left { display:flex; align-items:center; gap:12px; }
        .cc-avatar {
            width:36px; height:36px; border-radius:50%;
            background:rgba(255,255,255,0.15); border:1px solid rgba(255,255,255,0.25);
            display:flex; align-items:center; justify-content:center;
            color:#fff; flex-shrink:0;
        }
        .cc-avatar svg { width: 18px; height: 18px; fill: currentColor; }
        .cc-status-container { display: flex; align-items: center; font-size:12px; font-weight:400; opacity:0.9; margin-top:2px; }
        .cc-online { width:8px; height:8px; background:#10b981; border-radius:50%; display:inline-block; margin-right:6px; position:relative; }
        .cc-online::after { content:''; position:absolute; width:100%; height:100%; background:inherit; border-radius:inherit; left:0; top:0; animation:ccPulseGreen 2s infinite; }
        @keyframes ccPulseGreen { 0%{transform:scale(1); opacity:1;} 100%{transform:scale(2.5); opacity:0;} }
        
        .cc-close-btn { background:none; border:none; color:#fff; opacity:0.75; transition:opacity 0.2s, transform 0.2s; cursor:pointer; padding:6px; border-radius:50%; display:flex; align-items:center; justify-content:center; }
        .cc-close-btn:hover { opacity:1; background: rgba(255,255,255,0.1); transform: scale(1.05); }
        .cc-close-btn svg { width: 14px; height: 14px; stroke: currentColor; }
        
        .cc-chatbox {
            flex:1; padding:20px; overflow-y:auto; display:flex;
            flex-direction:column; gap:14px; background:#f8fafc;
            scroll-behavior:smooth;
        }
        .cc-chatbox::-webkit-scrollbar { width:5px; }
        .cc-chatbox::-webkit-scrollbar-track { background: transparent; }
        .cc-chatbox::-webkit-scrollbar-thumb { background:#cbd5e1; border-radius:10px; }
        .cc-chatbox::-webkit-scrollbar-thumb:hover { background:#94a3b8; }
        
        .cc-bubble {
            max-width:80%; padding:12px 16px; border-radius:18px;
            font-size:14px; line-height:1.5; word-break:break-word;
            white-space:pre-wrap; box-shadow: 0 1px 2px rgba(0,0,0,0.02);
        }
        .cc-user {
            background:${themeColor}; color:#fff; align-self:flex-end;
            border-bottom-right-radius:4px;
            box-shadow:0 4px 12px rgba(0,0,0,0.08);
        }
        .cc-ai {
            background:#fff; color:#0f172a; align-self:flex-start;
            border-bottom-left-radius:4px; border:1px solid #e2e8f0;
            box-shadow:0 4px 10px rgba(15,23,42,0.03);
        }
        
        .cc-footer {
            padding:14px 18px; background:#fff;
            border-top:1px solid #f1f5f9;
            display:flex; gap:10px; align-items:center; flex-shrink:0;
        }
        .cc-input {
            flex:1; background:#f1f5f9; border:1.5px solid transparent;
            color:#0f172a; outline:none; font-family:inherit;
            padding:${typebarSize === 'large' ? '14px 18px' : '11px 16px'};
            font-size:${typebarSize === 'large' ? '15px' : '14px'};
            border-radius:14px; transition:border-color 0.2s, background-color 0.2s;
        }
        .cc-input:focus { border-color:${themeColor}; background-color:#fff; box-shadow: 0 0 0 3px rgba(0,0,0,0.03); }
        
        .cc-send-btn {
            background:${themeColor}; border:none; color:#fff;
            cursor:pointer; display:flex; align-items:center; justify-content:center;
            padding:${sendButtonStyle === 'pill' ? '11px 20px' : '0'};
            width:${sendButtonStyle === 'pill' ? 'auto' : '42px'};
            height:42px; border-radius:${sendButtonStyle === 'pill' ? '21px' : '14px'};
            transition:opacity 0.2s, transform 0.2s, background-color 0.2s; flex-shrink:0;
        }
        .cc-send-btn svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
        .cc-send-btn:hover:not(:disabled) { opacity:0.95; transform:scale(1.04); }
        .cc-send-btn:disabled { opacity:0.4; cursor:not-allowed; transform:none; }
        
        .cc-mic-btn {
            background:none; border:none; color:#64748b; cursor:pointer;
            padding:8px; display:${voiceEnabled ? 'flex' : 'none'};
            align-items:center; justify-content:center; border-radius:50%; transition:background-color 0.2s, color 0.2s; flex-shrink:0;
        }
        .cc-mic-btn:hover { color:#0f172a; background-color:#f1f5f9; }
        .cc-mic-btn svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; }
        .cc-mic-btn.recording { color:#ef4444; background-color: #fef2f2; animation:ccPulse 1.4s infinite cubic-bezier(0.4, 0, 0.6, 1); }
        @keyframes ccPulse { 0%,100%{transform:scale(1)} 50%{transform:scale(1.08)} }
        
        .cc-typing {
            display:none; align-self:flex-start;
            background:#fff; border:1px solid #e2e8f0;
            padding:12px 18px; border-radius:18px; border-bottom-left-radius:4px;
            gap:6px; align-items:center; box-shadow:0 4px 10px rgba(15,23,42,0.03);
        }
        .cc-typing.visible { display:flex; }
        .cc-dot {
            width:6px; height:6px; border-radius:50%; background:#94a3b8;
            animation:ccBounce 1.4s ease-in-out infinite;
        }
        .cc-dot:nth-child(2) { animation-delay:0.2s; }
        .cc-dot:nth-child(3) { animation-delay:0.4s; }
        @keyframes ccBounce { 0%,80%,100%{transform:translateY(0)} 40%{transform:translateY(-5px)} }
    `;
    document.head.appendChild(style);

    // ── Build bubble ─────────────────────────────────────────────────────────
    const bubble = document.createElement('div');
    bubble.id = 'cc-widget-bubble';
    if (config.logoBase64) {
        bubble.style.backgroundImage = `url('${config.logoBase64}')`;
    } else {
        bubble.innerHTML = `<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/></svg>`;
    }
    document.body.appendChild(bubble);

    // ── Build window ─────────────────────────────────────────────────────────
    const win = document.createElement('div');
    win.id = 'cc-widget-window';

    // Header
    const header = document.createElement('div');
    header.className = 'cc-header';
    const headerLeft = document.createElement('div');
    headerLeft.className = 'cc-header-left';
    const avatar = document.createElement('div');
    avatar.className = 'cc-avatar';
    avatar.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 2c-4.97 0-9 4.03-9 9 0 2.12.74 4.07 1.97 5.61L4.35 19.4c-.39.39-.39 1.02 0 1.41.39.39 1.02.39 1.41 0l2.79-2.79C10.09 18.64 11.03 19 12 19c4.97 0 9-4.03 9-9s-4.03-9-9-9zm0 15c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6-2.69 6-6 6zm-2-7c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm4 0c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm-4 4h4c.55 0 1-.45 1-1s-.45-1-1-1h-4c-.55 0-1 .45-1 1s.45 1 1 1z"/></svg>`;
    
    const headerInfo = document.createElement('div');
    const botNameEl = document.createElement('div');
    botNameEl.style.fontWeight = '700';
    botNameEl.textContent = config.name;
    const statusEl = document.createElement('div');
    statusEl.className = 'cc-status-container';
    statusEl.innerHTML = '<span class="cc-online"></span>Online';
    headerInfo.appendChild(botNameEl);
    headerInfo.appendChild(statusEl);
    headerLeft.appendChild(avatar);
    headerLeft.appendChild(headerInfo);
    
    const closeBtn = document.createElement('button');
    closeBtn.className = 'cc-close-btn';
    closeBtn.setAttribute('aria-label', 'Close chat');
    closeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    header.appendChild(headerLeft);
    header.appendChild(closeBtn);
    win.appendChild(header);

    // Chat box
    const chatBox = document.createElement('div');
    chatBox.className = 'cc-chatbox';
    chatBox.id = 'ccChatBox';
    win.appendChild(chatBox);

    // Typing indicator
    const typingEl = document.createElement('div');
    typingEl.className = 'cc-typing';
    typingEl.id = 'ccTyping';
    typingEl.innerHTML = '<div class="cc-dot"></div><div class="cc-dot"></div><div class="cc-dot"></div>';
    chatBox.appendChild(typingEl);

    // Footer
    const footer = document.createElement('div');
    footer.className = 'cc-footer';
    
    const micBtn = document.createElement('button');
    micBtn.className = 'cc-mic-btn';
    micBtn.id = 'ccMicBtn';
    micBtn.setAttribute('aria-label', 'Voice input');
    micBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1M12 19v3M8 22h8"/></svg>`;
    
    const inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.className = 'cc-input';
    inputEl.id = 'ccInput';
    inputEl.placeholder = 'Type a message…';
    inputEl.setAttribute('autocomplete', 'off');
    
    const sendBtn = document.createElement('button');
    sendBtn.className = 'cc-send-btn';
    sendBtn.id = 'ccSendBtn';
    sendBtn.setAttribute('aria-label', 'Send message');
    if (sendButtonStyle === 'pill') {
        sendBtn.textContent = 'Send';
    } else {
        sendBtn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>`;
    }
    
    footer.appendChild(micBtn);
    footer.appendChild(inputEl);
    footer.appendChild(sendBtn);
    win.appendChild(footer);
    document.body.appendChild(win);

    // ── XSS-safe message appender ────────────────────────────────────────────
    function appendMsg(text, isUser) {
        const el = document.createElement('div');
        el.className = `cc-bubble ${isUser ? 'cc-user' : 'cc-ai'}`;
        el.textContent = text;
        chatBox.insertBefore(el, typingEl);
        chatBox.scrollTop = chatBox.scrollHeight;
        return el;
    }

    // Initial greeting
    appendMsg('Hello! How can I assist you today?', false);

    // ── Toggle window ────────────────────────────────────────────────────────
    bubble.addEventListener('click', () => {
        const isOpen = win.style.display === 'flex';
        win.style.display = isOpen ? 'none' : 'flex';
        if (!isOpen) {
            win.style.animation = 'none';
            void win.offsetWidth;
            win.style.animation = '';
            setTimeout(() => inputEl.focus(), 50);
        }
    });
    closeBtn.addEventListener('click', () => { win.style.display = 'none'; });

    // ── Send message ─────────────────────────────────────────────────────────
    async function sendMessage() {
        const text = inputEl.value.trim();
        if (!text || isSending) return;

        isSending = true;
        sendBtn.disabled = true;
        inputEl.value = '';
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

    // ── Voice input ──────────────────────────────────────────────────────────
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
