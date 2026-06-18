(async function () {
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
            loadingAnim:     'dots',
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
            font-size:26px; cursor:pointer; box-shadow:0 10px 25px rgba(0,0,0,0.2);
            transition:transform 0.2s, box-shadow 0.2s; z-index:999999;
            user-select:none; color:#fff; background-size:cover;
            background-position:center; border:2px solid #fff;
            will-change:transform;
        }
        #cc-widget-bubble:hover { transform:scale(1.08); box-shadow:0 14px 30px rgba(0,0,0,0.25); }
        #cc-widget-window {
            position:fixed; ${pos.window}
            width:360px; height:520px; background:#fff;
            border:1px solid #e5e7eb; border-radius:20px; display:none;
            flex-direction:column; overflow:hidden;
            box-shadow:0 24px 48px rgba(0,0,0,0.18);
            z-index:999999; font-family:system-ui,-apple-system,sans-serif;
            color:#111827; will-change:transform, opacity;
            animation:ccSlideIn 0.25s cubic-bezier(0.16,1,0.3,1) forwards;
        }
        @keyframes ccSlideIn { from{opacity:0;transform:translateY(12px) scale(0.97)} to{opacity:1;transform:none} }
        .cc-header {
            padding:16px 20px; background:${themeColor}; color:#fff;
            font-weight:700; font-size:15px;
            display:flex; align-items:center; justify-content:space-between;
            flex-shrink:0;
        }
        .cc-header-left { display:flex; align-items:center; gap:10px; }
        .cc-avatar {
            width:32px; height:32px; border-radius:50%;
            background:rgba(255,255,255,0.25);
            display:flex; align-items:center; justify-content:center;
            font-size:16px; flex-shrink:0;
        }
        .cc-online { width:8px; height:8px; background:#22c55e; border-radius:50%; display:inline-block; margin-right:6px; animation:ccPulseGreen 2s infinite; }
        @keyframes ccPulseGreen { 0%,100%{opacity:1} 50%{opacity:0.5} }
        .cc-close-btn { background:none; border:none; color:#fff; font-size:22px; cursor:pointer; line-height:1; padding:0 4px; opacity:0.8; transition:opacity 0.15s; }
        .cc-close-btn:hover { opacity:1; }
        .cc-chatbox {
            flex:1; padding:16px; overflow-y:auto; display:flex;
            flex-direction:column; gap:10px; background:#f9fafb;
            scroll-behavior:smooth;
        }
        .cc-chatbox::-webkit-scrollbar { width:4px; }
        .cc-chatbox::-webkit-scrollbar-thumb { background:#d1d5db; border-radius:4px; }
        .cc-bubble {
            max-width:82%; padding:11px 15px; border-radius:16px;
            font-size:14px; line-height:1.5; word-break:break-word;
            white-space:pre-wrap;
        }
        .cc-user {
            background:${themeColor}; color:#fff; align-self:flex-end;
            border-bottom-right-radius:4px;
            box-shadow:0 2px 8px rgba(0,0,0,0.1);
        }
        .cc-ai {
            background:#fff; color:#111827; align-self:flex-start;
            border-bottom-left-radius:4px;
            border:1px solid #e5e7eb;
            box-shadow:0 1px 4px rgba(0,0,0,0.06);
        }
        /* WhatsApp session card */
        .cc-wa-card {
            align-self:flex-start; max-width:90%;
            background:#fff; border:1px solid #e5e7eb;
            border-radius:16px; border-bottom-left-radius:4px;
            padding:14px 16px;
            box-shadow:0 1px 4px rgba(0,0,0,0.06);
            font-size:13px; line-height:1.5; color:#374151;
        }
        .cc-wa-card strong { color:#111827; }
        .cc-wa-card .cc-qr-img {
            display:block; margin:10px auto 8px;
            width:130px; height:130px; border-radius:8px;
            border:1px solid #e5e7eb;
        }
        .cc-wa-link {
            display:inline-flex; align-items:center; gap:6px;
            margin-top:8px; padding:8px 14px;
            background:#25d366; color:#fff; border-radius:20px;
            font-size:13px; font-weight:600; text-decoration:none;
            transition:opacity 0.15s;
        }
        .cc-wa-link:hover { opacity:0.88; }
        .cc-footer {
            padding:12px 14px; background:#fff;
            border-top:1px solid #e5e7eb;
            display:flex; gap:8px; align-items:center; flex-shrink:0;
        }
        .cc-input {
            flex:1; background:#f3f4f6; border:1.5px solid transparent;
            color:#111827; outline:none;
            padding:${typebarSize === 'large' ? '13px 16px' : '10px 14px'};
            font-size:${typebarSize === 'large' ? '15px' : '14px'};
            border-radius:12px; transition:border-color 0.15s, background 0.15s;
            font-family:inherit;
        }
        .cc-input:focus { border-color:${themeColor}; background:#fff; }
        .cc-send-btn {
            background:${themeColor}; border:none; color:#fff;
            cursor:pointer; font-weight:700;
            display:flex; align-items:center; justify-content:center;
            padding:${sendButtonStyle === 'pill' ? '10px 18px' : '0'};
            width:${sendButtonStyle === 'pill' ? 'auto' : '40px'};
            height:40px; border-radius:${sendButtonStyle === 'pill' ? '20px' : '12px'};
            transition:opacity 0.15s, transform 0.15s; font-size:18px;
            flex-shrink:0;
        }
        .cc-send-btn:hover:not(:disabled) { opacity:0.88; transform:scale(1.04); }
        .cc-send-btn:disabled { opacity:0.5; cursor:not-allowed; }
        .cc-mic-btn {
            background:none; border:none; font-size:18px; cursor:pointer;
            padding:4px 6px; display:${voiceEnabled ? 'flex' : 'none'};
            align-items:center; opacity:0.7; transition:opacity 0.15s; flex-shrink:0;
        }
        .cc-mic-btn:hover { opacity:1; }
        .cc-mic-btn.recording { color:#ef4444; animation:ccPulse 1.2s infinite; }
        @keyframes ccPulse { 0%,100%{transform:scale(1)} 50%{transform:scale(1.15)} }
        .cc-typing {
            display:none; align-self:flex-start;
            background:#fff; border:1px solid #e5e7eb;
            padding:10px 14px; border-radius:16px; border-bottom-left-radius:4px;
            gap:5px; align-items:center;
        }
        .cc-typing.visible { display:flex; }
        .cc-dot {
            width:7px; height:7px; border-radius:50%; background:#94a3b8;
            animation:ccBounce 1.2s ease-in-out infinite;
        }
        .cc-dot:nth-child(2) { animation-delay:0.2s; }
        .cc-dot:nth-child(3) { animation-delay:0.4s; }
        @keyframes ccBounce { 0%,80%,100%{transform:translateY(0)} 40%{transform:translateY(-6px)} }
    `;
    document.head.appendChild(style);

    // ── Build bubble ─────────────────────────────────────────────────────────
    const bubble = document.createElement('div');
    bubble.id = 'cc-widget-bubble';
    if (config.logoBase64) {
        bubble.style.backgroundImage = `url('${config.logoBase64}')`;
    } else {
        bubble.textContent = '💬';
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
    avatar.textContent = '🤖';
    const headerInfo = document.createElement('div');
    const botNameEl = document.createElement('div');
    botNameEl.style.fontWeight = '700';
    botNameEl.textContent = config.name;
    const statusEl = document.createElement('div');
    statusEl.style.cssText = 'font-size:11px;font-weight:400;opacity:0.85;margin-top:1px;';
    statusEl.innerHTML = '<span class="cc-online"></span>Online';
    headerInfo.appendChild(botNameEl);
    headerInfo.appendChild(statusEl);
    headerLeft.appendChild(avatar);
    headerLeft.appendChild(headerInfo);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'cc-close-btn';
    closeBtn.setAttribute('aria-label', 'Close chat');
    closeBtn.textContent = '×';
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
    micBtn.textContent = '🎤';
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
    sendBtn.textContent = sendButtonStyle === 'pill' ? 'Send' : '➔';
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

    /**
     * Show a WhatsApp "session required" card with QR code + tap-to-open link.
     * This appears whenever the backend returns waSessionRequired: true.
     */
    function appendWASessionCard(waLink, qrUrl) {
        // Don't show duplicate cards
        if (chatBox.querySelector('.cc-wa-card')) {
            chatBox.scrollTop = chatBox.scrollHeight;
            return;
        }

        const card = document.createElement('div');
        card.className = 'cc-wa-card';

        const title = document.createElement('strong');
        title.textContent = '📲 Connect WhatsApp to receive notifications';
        card.appendChild(title);

        const desc = document.createElement('p');
        desc.style.cssText = 'margin:8px 0 0; font-size:12px; color:#6b7280;';
        desc.textContent = 'Scan the QR or tap the button to send us a quick message. After that, all confirmations & OTPs will be delivered automatically.';
        card.appendChild(desc);

        if (qrUrl) {
            const qr = document.createElement('img');
            qr.className = 'cc-qr-img';
            qr.src = qrUrl;
            qr.alt = 'WhatsApp QR code';
            card.appendChild(qr);
        }

        if (waLink) {
            const link = document.createElement('a');
            link.className = 'cc-wa-link';
            link.href = waLink;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = '💬 Open WhatsApp';
            card.appendChild(link);

            const hint = document.createElement('p');
            hint.style.cssText = 'margin:8px 0 0; font-size:11px; color:#9ca3af;';
            hint.textContent = 'Message will be pre-filled. Just press Send in WhatsApp, then come back here.';
            card.appendChild(hint);
        }

        chatBox.insertBefore(card, typingEl);
        chatBox.scrollTop = chatBox.scrollHeight;
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

            // If the backend couldn't deliver a WhatsApp message due to the 24h window,
            // show the QR + link card so the user can open the session themselves.
            if (data.waSessionRequired && data.waLink) {
                appendWASessionCard(data.waLink, data.qrUrl);
            }

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
