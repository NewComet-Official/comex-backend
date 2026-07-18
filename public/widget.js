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

    // ── Persistence: survive a page refresh mid human-conversation ───────────
    const SESSION_KEY = `comex_widget_session_${businessId}`;
    function loadSession() {
        try {
            const raw = localStorage.getItem(SESSION_KEY);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (e) { return null; }
    }
    function saveSession() {
        try {
            localStorage.setItem(SESSION_KEY, JSON.stringify({
                conversationId, chatHistory: chatHistory.slice(-30),
                humanSessionActive, humanRequestId, humanLastPollISO,
                humanRenderedIds: Array.from(humanRenderedIds),
            }));
        } catch (e) { /* storage may be unavailable — degrade gracefully */ }
    }
    function clearHumanFromSession() {
        humanSessionActive = false; humanRequestId = null; humanLastPollISO = null;
        humanRenderedIds = new Set();
        saveSession();
    }

    const existingSession = loadSession();
    const conversationId = existingSession?.conversationId || `conv-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // ── Human handoff session state ──────────────────────────────────────────
    let humanSessionActive = !!(existingSession?.humanSessionActive && existingSession?.humanRequestId);
    let humanRequestId     = existingSession?.humanRequestId || null;
    let humanPollTimer     = null;
    let humanLastPollISO   = existingSession?.humanLastPollISO || null;
    // Tracks message doc IDs already rendered so a slow/overlapping poll
    // cycle can never render the same message twice.
    let humanRenderedIds   = new Set(existingSession?.humanRenderedIds || []);
    // Prevents two poll cycles from running concurrently (e.g. a slow
    // network response still in flight when the next interval tick fires),
    // which was the root cause of messages appearing doubled/tripled.
    let humanPollInFlight  = false;
    if (existingSession?.chatHistory?.length) chatHistory = existingSession.chatHistory;

    // ── Default Configuration ────────────────────────────────────────────────
    let config = {
        name: 'AI Assistant',
        position: 'bottom-right',
        logoBase64: null,
        designConfig: {
            themeColor:      '#0f172a',
            typebarSize:      'standard',
            sendButtonStyle: 'icon',
            loadingAnim:      'dots',
            voiceEnabled:    false
        },
        behaviorConfig: {
            allowOutOfTopic: true,
            allowWebSearch: true,
            allowHallucination: false,
            allowAppointmentBooking: false
        },
        messageConfig: {
            user: { showTime: true, editMessage: true, copy: true },
            bot:  { showTime: true, copy: true, regenerate: true, report: true }
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
                if (result.behaviorConfig) config.behaviorConfig = { ...config.behaviorConfig, ...result.behaviorConfig };
                if (result.messageConfig) {
                    config.messageConfig = {
                        user: { ...config.messageConfig.user, ...(result.messageConfig.user || {}) },
                        bot:  { ...config.messageConfig.bot,  ...(result.messageConfig.bot  || {}) }
                    };
                }
            }
        }
    } catch (err) {
        console.warn('Comex Widget: Could not fetch config, using defaults.', err);
    }

    const { themeColor, typebarSize, sendButtonStyle, loadingAnim, voiceEnabled } = config.designConfig;
    const userMsgCfg = config.messageConfig.user;
    const botMsgCfg  = config.messageConfig.bot;

    // ── Position Computations ────────────────────────────────────────────────
    const positions = {
        'bottom-right': { bubble: 'bottom:24px; right:24px;', window: 'bottom:100px; right:24px; transform-origin: bottom right;' },
        'bottom-left':  { bubble: 'bottom:24px; left:24px;',  window: 'bottom:100px; left:24px; transform-origin: bottom left;'  },
        'top-right':    { bubble: 'top:24px; right:24px;',    window: 'top:100px; right:24px; transform-origin: top right;'     },
        'top-left':     { bubble: 'top:24px; left:24px;',     window: 'top:100px; left:24px; transform-origin: top left;'      }
    };
    const pos = positions[config.position] || positions['bottom-right'];

    // ── Inject Premium Ultra-Modern Styles ───────────────────────────────────
    const style = document.createElement('style');
    style.textContent = `
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap');
        
        #cc-widget-bubble {
            position: fixed; ${pos.bubble}
            width: 60px; height: 60px; background-color: ${themeColor};
            border-radius: 50%; display: flex; align-items: center; justify-content: center;
            cursor: pointer; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.24), inset 0 2px 4px rgba(255,255,255,0.15);
            transition: transform 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275), box-shadow 0.3s; z-index: 999999;
            user-select: none; color: #fff; background-size: cover; background-position: center;
            border: 1px solid rgba(255,255,255,0.1); will-change: transform;
        }
        #cc-widget-bubble:hover { transform: scale(1.08) translateY(-2px); box-shadow: 0 12px 40px rgba(0, 0, 0, 0.32); }
        #cc-widget-bubble:active { transform: scale(0.94); }
        #cc-widget-bubble svg { width: 26px; height: 26px; fill: currentColor; transition: transform 0.3s ease; }
        
        #cc-widget-window {
            position: fixed; ${pos.window}
            width: 410px; 
            height: 660px; 
            max-height: calc(100vh - 130px); /* FIX: Prevents overflow on non-fullscreen or laptop screens */
            background: #ffffff;
            border: 1px solid rgba(226, 232, 240, 0.8); border-radius: 24px; display: none;
            flex-direction: column; overflow: hidden; 
            box-shadow: 0 20px 50px -12px rgba(15, 23, 42, 0.15), 0 0 1px 1px rgba(0,0,0,0.03);
            z-index: 999999; font-family: 'Plus Jakarta Sans', -apple-system, sans-serif;
            color: #0f172a; will-change: transform, opacity; opacity: 0;
            transition: opacity 0.3s cubic-bezier(0.34, 1.56, 0.64, 1), transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        #cc-widget-window.cc-open { display: flex; opacity: 1; transform: scale(1) translateY(0); }
        #cc-widget-window.cc-closed { transform: scale(0.9) translateY(20px); opacity: 0; }
        
        .cc-header {
            padding: 22px 24px; background: ${themeColor}; color: #fff;
            display: flex; align-items: center; justify-content: space-between;
            flex-shrink: 0; position: relative; overflow: hidden;
        }
        .cc-header::before {
            content: ''; position: absolute; top: -50%; left: -50%; width: 200%; height: 200%;
            background: radial-gradient(circle, rgba(255,255,255,0.12) 0%, transparent 65%); pointer-events: none;
        }
        .cc-header-left { display: flex; align-items: center; gap: 14px; position: relative; z-index: 1; }
        .cc-avatar-container { position: relative; }
        .cc-avatar {
            width: 44px; height: 44px; border-radius: 50%;
            background: rgba(255,255,255,0.15); border: 1px solid rgba(255,255,255,0.25);
            display: flex; align-items: center; justify-content: center; color: #fff; flex-shrink: 0;
        }
        .cc-avatar svg { width: 22px; height: 22px; fill: currentColor; }
        .cc-status-dot {
            width: 12px; height: 12px; background: #10b981; border: 2.5px solid ${themeColor};
            border-radius: 50%; position: absolute; bottom: -1px; right: -1px;
        }
        .cc-status-dot::after {
            content: ''; position: absolute; width: 100%; height: 100%; background: inherit;
            border-radius: inherit; left: -2.5px; top: -2.5px; border: 2.5px solid transparent; animation: ccPulseGreen 2s infinite;
        }
        @keyframes ccPulseGreen { 0% { transform: scale(1); opacity: 1; } 100% { transform: scale(2.5); opacity: 0; } }
        
        .cc-bot-title { font-weight: 700; font-size: 16px; letter-spacing: -0.02em; margin-bottom: 2px; }
        .cc-bot-status { font-size: 12px; opacity: 0.85; font-weight: 500; display: flex; align-items: center; gap: 4px; }
        
        .cc-header-actions { display: flex; align-items: center; gap: 4px; position: relative; z-index: 1; }
        .cc-close-btn, .cc-endchat-btn {
            background: transparent; border: none; color: #fff; opacity: 0.8;
            transition: all 0.2s; cursor: pointer; width: 34px; height: 34px; border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
        }
        .cc-close-btn:hover { opacity: 1; background: rgba(255,255,255,0.15); transform: rotate(90deg); }
        .cc-close-btn svg { width: 18px; height: 18px; stroke: currentColor; }
        .cc-endchat-btn:hover { opacity: 1; background: rgba(239,68,68,0.35); }
        .cc-endchat-btn svg { width: 17px; height: 17px; stroke: currentColor; }

        /* ── END CHAT CONFIRM ── */
        .cc-confirm-overlay {
            position: fixed; inset: 0; background: rgba(2,6,23,0.55); z-index: 1000001;
            display: flex; align-items: center; justify-content: center; padding: 20px;
            font-family: 'Plus Jakarta Sans', -apple-system, sans-serif;
        }
        .cc-confirm-card { background: #fff; border-radius: 18px; width: 100%; max-width: 320px; padding: 24px; box-shadow: 0 20px 50px rgba(0,0,0,0.3); text-align: center; }
        .cc-confirm-card p { font-size: 14px; font-weight: 600; color: #0f172a; margin-bottom: 18px; line-height: 1.5; }
        .cc-confirm-actions { display: flex; gap: 10px; }
        .cc-confirm-actions button { flex: 1; padding: 11px; border-radius: 100px; font-weight: 700; font-size: 13px; cursor: pointer; border: none; font-family: inherit; }
        .cc-confirm-cancel { background: #f1f5f9; color: #475569; }
        .cc-confirm-ok { background: #ef4444; color: #fff; }

        .cc-chatbox {
            flex: 1; padding: 24px; overflow-y: auto; display: flex;
            flex-direction: column; gap: 18px; background: #f8fafc; scroll-behavior: smooth;
        }
        .cc-chatbox::-webkit-scrollbar { width: 5px; }
        .cc-chatbox::-webkit-scrollbar-track { background: transparent; }
        .cc-chatbox::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 10px; }
        
        .cc-welcome-card {
            background: #ffffff; border: 1px solid #f1f5f9; border-radius: 20px;
            padding: 24px; text-align: left; margin-bottom: 6px;
            box-shadow: 0 10px 25px -5px rgba(15,23,42,0.03);
        }
        .cc-welcome-card p { margin: 0 0 18px 0; font-size: 14.5px; color: #475569; line-height: 1.6; font-weight: 500; }
        .cc-suggested-grid { display: flex; flex-direction: column; gap: 10px; }
        .cc-suggested-chip {
            background: #f1f5f9; border: 1px solid transparent; padding: 12px 16px;
            border-radius: 12px; font-size: 13.5px; color: #334155; text-align: left;
            cursor: pointer; transition: all 0.25s ease; font-weight: 600;
            display: flex; align-items: center; justify-content: space-between;
        }
        .cc-suggested-chip:hover { background: #ffffff; border-color: ${themeColor}; color: ${themeColor}; transform: translateX(4px); box-shadow: 0 4px 12px rgba(0,0,0,0.05); }

        .cc-bubble-container { display: flex; flex-direction: column; width: 100%; animation: ccFadeIn 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) forwards; }
        @keyframes ccFadeIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
        
        .cc-bubble {
            max-width: 80%; padding: 14px 18px; border-radius: 20px;
            font-size: 14.5px; line-height: 1.6; word-break: break-word;
            font-weight: 500;
        }
        .cc-bubble p { margin: 0 0 8px 0; }
        .cc-bubble p:last-child { margin-bottom: 0; }
        
        .cc-user { align-items: flex-end; }
        .cc-user .cc-bubble {
            background: ${themeColor}; color: #fff; border-bottom-right-radius: 4px;
            box-shadow: 0 8px 20px -4px rgba(0,0,0,0.12);
        }
        .cc-ai { align-items: flex-start; }
        .cc-ai .cc-bubble {
            background: #ffffff; color: #1e293b; border-bottom-left-radius: 4px;
            border: 1px solid rgba(226,232,240,0.8); box-shadow: 0 8px 20px -4px rgba(15,23,42,0.04);
        }
        .cc-agent .cc-bubble {
            background: #ecfdf5; color: #065f46; border-bottom-left-radius: 4px;
            border: 1px solid #a7f3d0; box-shadow: 0 8px 20px -4px rgba(15,23,42,0.04);
        }
        .cc-system-note {
            text-align: center; font-size: 12px; color: #94a3b8; font-weight: 600;
            padding: 4px 0; margin: 2px 0;
        }
        .cc-meta-row { display: flex; align-items: center; gap: 10px; margin-top: 6px; padding: 0 6px; }
        .cc-user .cc-meta-row { flex-direction: row-reverse; }
        .cc-meta { font-size: 11px; color: #94a3b8; font-weight: 500; }
        .cc-msg-actions { display: flex; align-items: center; gap: 4px; opacity: 0; transition: opacity 0.15s ease; }
        .cc-bubble-container:hover .cc-msg-actions { opacity: 1; }
        .cc-action-btn {
            background: transparent; border: none; cursor: pointer; color: #94a3b8;
            width: 22px; height: 22px; display: flex; align-items: center; justify-content: center;
            border-radius: 6px; transition: background 0.15s, color 0.15s; padding: 0;
        }
        .cc-action-btn:hover { background: #e2e8f0; color: #334155; }
        .cc-action-btn.cc-reported { color: #ef4444; }
        .cc-action-btn svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
        
        .cc-footer {
            padding: 18px 24px; background: #ffffff; border-top: 1px solid #f1f5f9;
            display: flex; gap: 12px; align-items: center; flex-shrink: 0;
        }
        .cc-input-wrapper { flex: 1; position: relative; display: flex; align-items: center; }
        .cc-input {
            width: 100%; background: #f8fafc; border: 1.5px solid #e2e8f0;
            color: #0f172a; outline: none; font-family: inherit;
            padding: ${typebarSize === 'large' ? '14px 46px 14px 18px' : '12px 46px 12px 18px'};
            font-size: 14.5px; border-radius: 16px; transition: all 0.25s ease;
            font-weight: 500;
        }
        .cc-input:focus { border-color: ${themeColor}; background-color: #fff; box-shadow: 0 0 0 4px rgba(15,23,42,0.06); }
        
        .cc-send-btn {
            background: ${themeColor}; border: none; color: #fff;
            cursor: pointer; display: flex; align-items: center; justify-content: center;
            padding: ${sendButtonStyle === 'pill' ? '0 24px' : '0'};
            width: ${sendButtonStyle === 'pill' ? 'auto' : '48px'};
            height: 48px; border-radius: ${sendButtonStyle === 'pill' ? '24px' : '16px'};
            transition: all 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275); flex-shrink: 0;
            box-shadow: 0 4px 12px rgba(0,0,0,0.08);
        }
        .cc-send-btn svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; transition: transform 0.2s; }
        .cc-send-btn:hover:not(:disabled) { transform: scale(1.04) translateY(-1px); box-shadow: 0 8px 20px rgba(0,0,0,0.15); }
        .cc-send-btn:hover:not(:disabled) svg { transform: translateX(2px); }
        .cc-send-btn:disabled { opacity: 0.35; cursor: not-allowed; transform: none; box-shadow: none; }
        
        .cc-mic-btn {
            position: absolute; right: 14px; background: none; border: none; color: #64748b;
            cursor: pointer; padding: 6px; display: ${voiceEnabled ? 'flex' : 'none'};
            align-items: center; justify-content: center; border-radius: 50%; transition: all 0.2s;
        }
        .cc-mic-btn:hover { color: #0f172a; background-color: #e2e8f0; }
        .cc-mic-btn svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2; }
        .cc-mic-btn.recording { color: #ef4444; background-color: #fef2f2; animation: ccPulse 1.4s infinite cubic-bezier(0.4, 0, 0.6, 1); }
        @keyframes ccPulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.1); } }
        
        .cc-typing {
            display: none; align-self: flex-start; background: #fff; border: 1px solid rgba(226,232,240,0.8);
            padding: 14px 22px; border-radius: 20px; border-bottom-left-radius: 4px;
            gap: 6px; align-items: center; box-shadow: 0 4px 12px rgba(15,23,42,0.03);
        }
        .cc-typing.visible { display: flex; }
        .cc-dot { width: 8px; height: 8px; border-radius: 50%; background: #94a3b8; animation: ccBounce 1.4s ease-in-out infinite; }
        .cc-dot:nth-child(2) { animation-delay: 0.2s; }
        .cc-dot:nth-child(3) { animation-delay: 0.4s; }
        @keyframes ccBounce { 0%,80%,100% { transform: translateY(0); } 40% { transform: translateY(-6px); } }

        .cc-brand-footer { text-align: center; font-size: 11px; color: #94a3b8; padding: 0 0 16px 0; background: #fff; font-weight: 600; letter-spacing: 0.02em; }
        .cc-brand-footer a { color: #64748b; text-decoration: none; font-weight: 700; transition: color 0.2s; }
        .cc-brand-footer a:hover { color: ${themeColor}; }

        /* ── REPORT MODAL ── */
        .cc-report-overlay {
            position: fixed; inset: 0; background: rgba(2,6,23,0.55); z-index: 1000000;
            display: flex; align-items: center; justify-content: center; padding: 20px;
            font-family: 'Plus Jakarta Sans', -apple-system, sans-serif;
        }
        .cc-report-card {
            background: #fff; border-radius: 20px; width: 100%; max-width: 400px;
            max-height: 90vh; overflow-y: auto; padding: 26px; box-shadow: 0 20px 50px rgba(0,0,0,0.3);
        }
        .cc-report-card h3 { margin: 0 0 4px; font-size: 17px; color: #0f172a; font-weight: 800; }
        .cc-report-card p.cc-rsub { margin: 0 0 18px; font-size: 12.5px; color: #64748b; font-weight: 500; }
        .cc-rfield { margin-bottom: 14px; }
        .cc-rfield label { display:block; font-size: 11.5px; font-weight: 700; color: #334155; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.03em; }
        .cc-rfield input, .cc-rfield textarea {
            width: 100%; border: 1.5px solid #e2e8f0; border-radius: 10px; padding: 10px 12px;
            font-family: inherit; font-size: 13.5px; outline: none; box-sizing: border-box; resize: vertical;
        }
        .cc-rfield input:focus, .cc-rfield textarea:focus { border-color: ${themeColor}; }
        .cc-rfield textarea[readonly] { background: #f8fafc; color: #64748b; }
        .cc-rphone-row { display: flex; gap: 8px; }
        .cc-rphone-row input:first-child { width: 78px; flex-shrink: 0; }
        .cc-rstars { display: flex; gap: 6px; }
        .cc-rstar { font-size: 24px; cursor: pointer; color: #e2e8f0; user-select: none; transition: color 0.15s, transform 0.1s; }
        .cc-rstar.active { color: #f59e0b; }
        .cc-rstar:hover { transform: scale(1.15); }
        .cc-report-actions { display: flex; gap: 10px; margin-top: 20px; }
        .cc-report-actions button {
            flex: 1; padding: 12px; border-radius: 100px; font-weight: 700; font-size: 13.5px;
            cursor: pointer; border: none; font-family: inherit;
        }
        .cc-rcancel { background: #f1f5f9; color: #475569; }
        .cc-rsubmit { background: ${themeColor}; color: #fff; }
        .cc-rerror { color: #ef4444; font-size: 12px; font-weight: 600; margin-top: -6px; margin-bottom: 12px; display: none; }
        
        @media (max-width: 480px) {
            #cc-widget-window {
                width: 100% !important; height: 100% !important; max-height: 100vh !important;
                bottom: 0 !important; right: 0 !important; left: 0 !important; top: 0 !important;
                border-radius: 0 !important; transform: none !important;
            }
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
    botNameEl.id = 'ccBotTitle';
    botNameEl.textContent = config.name;
    const statusEl = document.createElement('div');
    statusEl.className = 'cc-bot-status';
    statusEl.id = 'ccBotStatusLine';
    statusEl.textContent = 'Replies instantly';
    headerInfo.appendChild(botNameEl);
    headerInfo.appendChild(statusEl);
    
    headerLeft.appendChild(avatarContainer);
    headerLeft.appendChild(headerInfo);

    const headerActions = document.createElement('div');
    headerActions.className = 'cc-header-actions';

    const endChatBtn = document.createElement('button');
    endChatBtn.className = 'cc-endchat-btn';
    endChatBtn.id = 'ccEndChatBtn';
    endChatBtn.setAttribute('aria-label', 'End conversation with human agent');
    endChatBtn.title = 'End conversation';
    endChatBtn.style.display = 'none';
    endChatBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.362 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0 1 22 16.92z" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><line x1="2" y1="2" x2="22" y2="22" stroke-width="2" stroke-linecap="round"/></svg>`;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'cc-close-btn';
    closeBtn.setAttribute('aria-label', 'Close chat');
    closeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    headerActions.appendChild(endChatBtn);
    headerActions.appendChild(closeBtn);
    header.appendChild(headerLeft);
    header.appendChild(headerActions);
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
<!-- Services Chip -->
<div class="cc-suggested-chip" data-msg="What services do you offer?">
  <span>
    <svg xmlns="http://w3.org" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: text-bottom; margin-right: 6px;"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .6 2.2 1.5 3.1.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>
    What services do you offer?
  </span> 
  ➔
</div> 

<!-- Human Support Chip -->
<div class="cc-suggested-chip" data-msg="Speak to human support">
  <span>
    <svg xmlns="http://w3.org" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: text-bottom; margin-right: 6px;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
    Connect to human agent
  </span> 
  ➔
</div>

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
        
        clean = clean.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        clean = clean.replace(/`(.*?)`/g, '<code>$1</code>');
        return clean.split('\n').map(line => line.trim() ? `<p>${line}</p>` : '').join('');
    }

    function copyToClipboard(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).catch(() => _fallbackCopy(text));
        } else {
            _fallbackCopy(text);
        }
    }
    function _fallbackCopy(text) {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.focus(); ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(ta);
    }

    // ── Custom confirm dialog (replaces window.confirm for consistent UX) ────
    function ccConfirm(message) {
        return new Promise(resolve => {
            const overlay = document.createElement('div');
            overlay.className = 'cc-confirm-overlay';
            overlay.innerHTML = `
                <div class="cc-confirm-card">
                    <p>${message.replace(/</g, '&lt;')}</p>
                    <div class="cc-confirm-actions">
                        <button class="cc-confirm-cancel">Cancel</button>
                        <button class="cc-confirm-ok">End Chat</button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);
            overlay.querySelector('.cc-confirm-cancel').onclick = () => { overlay.remove(); resolve(false); };
            overlay.querySelector('.cc-confirm-ok').onclick = () => { overlay.remove(); resolve(true); };
            overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
        });
    }

    const ICONS = {
        copy: `<svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`,
        check: `<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
        edit: `<svg viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`,
        regen: `<svg viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>`,
        flag: `<svg viewBox="0 0 24 24"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"></path><line x1="4" y1="22" x2="4" y2="15"></line></svg>`
    };

    function appendMsg(text, isUser, opts) {
        opts = opts || {};
        const container = document.createElement('div');
        container.className = `cc-bubble-container ${isUser ? 'cc-user' : (opts.isAgent ? 'cc-agent' : 'cc-ai')}`;
        
        const bubbleEl = document.createElement('div');
        bubbleEl.className = 'cc-bubble';
        
        if (isUser) {
            bubbleEl.textContent = text;
        } else {
            bubbleEl.innerHTML = (opts.isAgent ? '<strong>🧑‍💻 Human Agent:</strong> ' : '') + parseMarkdown(text);
        }
        container.appendChild(bubbleEl);

        // ── Meta row: timestamp + action buttons ──
        const metaCfg = isUser ? userMsgCfg : botMsgCfg;
        const metaRow = document.createElement('div');
        metaRow.className = 'cc-meta-row';

        const actionsEl = document.createElement('div');
        actionsEl.className = 'cc-msg-actions';

        if (isUser) {
            if (userMsgCfg.copy) {
                const btn = document.createElement('button');
                btn.className = 'cc-action-btn'; btn.title = 'Copy';
                btn.innerHTML = ICONS.copy;
                btn.onclick = () => {
                    copyToClipboard(text);
                    btn.innerHTML = ICONS.check;
                    setTimeout(() => btn.innerHTML = ICONS.copy, 1200);
                };
                actionsEl.appendChild(btn);
            }
            if (userMsgCfg.editMessage && !opts.isHuman) {
                const btn = document.createElement('button');
                btn.className = 'cc-action-btn'; btn.title = 'Edit message';
                btn.innerHTML = ICONS.edit;
                btn.onclick = () => {
                    inputEl.value = text;
                    inputEl.focus();
                };
                actionsEl.appendChild(btn);
            }
        } else {
            if (botMsgCfg.copy) {
                const btn = document.createElement('button');
                btn.className = 'cc-action-btn'; btn.title = 'Copy';
                btn.innerHTML = ICONS.copy;
                btn.onclick = () => {
                    copyToClipboard(text);
                    btn.innerHTML = ICONS.check;
                    setTimeout(() => btn.innerHTML = ICONS.copy, 1200);
                };
                actionsEl.appendChild(btn);
            }
            if (botMsgCfg.regenerate && !opts.noRegenerate && !opts.isAgent) {
                const btn = document.createElement('button');
                btn.className = 'cc-action-btn'; btn.title = 'Regenerate answer';
                btn.innerHTML = ICONS.regen;
                btn.onclick = () => regenerateAnswer(container, bubbleEl, metaRow);
                actionsEl.appendChild(btn);
            }
            if (botMsgCfg.report && !opts.noReport && !opts.isAgent) {
                const btn = document.createElement('button');
                btn.className = 'cc-action-btn'; btn.title = 'Report this answer';
                btn.innerHTML = ICONS.flag;
                btn.onclick = () => openReportModal(text, btn);
                actionsEl.appendChild(btn);
            }
        }

        if (isUser) metaRow.appendChild(actionsEl);

        if (metaCfg.showTime) {
            const timeEl = document.createElement('div');
            timeEl.className = 'cc-meta';
            const now = new Date();
            timeEl.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            metaRow.appendChild(timeEl);
        }

        if (!isUser) metaRow.appendChild(actionsEl);

        container.appendChild(metaRow);
        
        chatBox.insertBefore(container, typingEl);
        chatBox.scrollTop = chatBox.scrollHeight;
        return { container, bubbleEl };
    }

    function appendSystemNote(text) {
        const note = document.createElement('div');
        note.className = 'cc-system-note';
        note.textContent = text;
        chatBox.insertBefore(note, typingEl);
        chatBox.scrollTop = chatBox.scrollHeight;
    }

    // ── Human handoff: poll for agent replies while a request is open ────────
    function startHumanPolling() {
        endChatBtn.style.display = 'flex';
        if (humanPollTimer) return;
        humanSessionActive = true;
        statusEl.textContent = 'Waiting for a team member…';
        saveSession();
        humanPollTimer = setInterval(pollHumanMessages, 4000);
        pollHumanMessages();
    }

    function stopHumanPolling(reason) {
        clearHumanFromSession();
        if (humanPollTimer) { clearInterval(humanPollTimer); humanPollTimer = null; }
        statusEl.textContent = 'Replies instantly';
        endChatBtn.style.display = 'none';
        if (reason) appendSystemNote(reason);
    }

    async function pollHumanMessages(isInitialReplay) {
        // Guard against overlapping poll cycles — if a prior fetch is still
        // in flight when the next interval tick fires (e.g. slow network),
        // letting both run concurrently is what caused messages to render
        // more than once.
        if (!humanRequestId || humanPollInFlight) return;
        humanPollInFlight = true;
        try {
            const url = `https://comex-backend.vercel.app/api/human/poll?requestId=${encodeURIComponent(humanRequestId)}` +
                        (humanLastPollISO ? `&sinceTs=${encodeURIComponent(humanLastPollISO)}` : '');
            const r = await fetch(url);
            const data = await r.json();
            if (!data.success) return;

            if (data.status === 'active') {
                statusEl.textContent = 'A team member has joined';
            } else if (data.status === 'pending') {
                statusEl.textContent = 'Waiting for a team member…';
            }

            (data.messages || []).forEach(m => {
                humanLastPollISO = m.createdAt;
                // Dedup by message id — belt-and-suspenders alongside the
                // in-flight guard above, in case of any timestamp-boundary
                // overlap between consecutive poll windows.
                if (humanRenderedIds.has(m.id)) return;
                humanRenderedIds.add(m.id);

                if (m.sender === 'agent' && !m.isSystem) {
                    appendMsg(m.text, false, { isAgent: true, noRegenerate: true, noReport: true });
                } else if (m.sender === 'agent' && m.isSystem) {
                    appendSystemNote(m.text);
                } else if (m.sender === 'user' && isInitialReplay) {
                    // Replaying history after a refresh — show the visitor's own prior messages too.
                    appendMsg(m.text, true, { isHuman: true });
                }
            });
            saveSession();

            if (data.status === 'closed') {
                stopHumanPolling("This conversation was closed — you're chatting with the AI assistant again.");
            }
        } catch (err) { /* silent — will retry next tick */ }
        finally {
            humanPollInFlight = false;
        }
    }

    // ── Regenerate: resend the last user message, replace this bot bubble ────
    async function regenerateAnswer(container, bubbleEl, metaRow) {
        const idx = chatHistory.length - 1;
        // find last user message before this bot message
        let lastUserContent = null;
        for (let i = chatHistory.length - 1; i >= 0; i--) {
            if (chatHistory[i].role === 'user') { lastUserContent = chatHistory[i].content; break; }
        }
        if (!lastUserContent) return;

        bubbleEl.innerHTML = '<p style="opacity:.6;">Regenerating…</p>';

        try {
            const historyForCall = chatHistory.slice(0, -1); // drop the old assistant reply
            const r = await fetch('https://comex-backend.vercel.app/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    businessId, message: lastUserContent, conversationId,
                    history: historyForCall.slice(-10)
                })
            });
            const data = await r.json();
            const reply = data.answer || data.reply || "Sorry, I couldn't process that.";
            bubbleEl.innerHTML = parseMarkdown(reply);
            if (chatHistory.length && chatHistory[chatHistory.length - 1].role === 'assistant') {
                chatHistory[chatHistory.length - 1].content = reply;
            } else {
                chatHistory.push({ role: 'assistant', content: reply });
            }
            saveSession();
        } catch (err) {
            bubbleEl.innerHTML = '<p>Could not regenerate. Please try again.</p>';
        }
    }

    // ── Report Modal ───────────────────────────────────────────────────────
    function openReportModal(botMessageText, triggerBtn) {
        const overlay = document.createElement('div');
        overlay.className = 'cc-report-overlay';
        overlay.innerHTML = `
            <div class="cc-report-card">
                <h3>Report this answer</h3>
                <p class="cc-rsub">Help us improve by letting us know what went wrong.</p>
                <div class="cc-rerror" id="ccRErr"></div>
                <div class="cc-rfield">
                    <label>Email *</label>
                    <input type="email" id="ccREmail" placeholder="you@example.com">
                </div>
                <div class="cc-rfield">
                    <label>Mobile Number *</label>
                    <div class="cc-rphone-row">
                        <input type="text" id="ccRCode" placeholder="+1">
                        <input type="text" id="ccRPhone" placeholder="Mobile number">
                    </div>
                </div>
                <div class="cc-rfield">
                    <label>What went wrong? *</label>
                    <textarea id="ccRText" rows="3" placeholder="Describe the issue with this answer..."></textarea>
                </div>
                <div class="cc-rfield">
                    <label>Bot's Answer (auto-filled)</label>
                    <textarea id="ccRBotMsg" rows="3" readonly></textarea>
                </div>
                <div class="cc-rfield">
                    <label>Feedback Rating (optional)</label>
                    <div class="cc-rstars" id="ccRStars">
                        ${[1,2,3,4,5].map(n => `<span class="cc-rstar" data-v="${n}">★</span>`).join('')}
                    </div>
                </div>
                <div class="cc-report-actions">
                    <button class="cc-rcancel" id="ccRCancel">Cancel</button>
                    <button class="cc-rsubmit" id="ccRSubmit">Submit Report</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        overlay.querySelector('#ccRBotMsg').value = botMessageText;

        let rating = 0;
        overlay.querySelectorAll('.cc-rstar').forEach(star => {
            star.onclick = () => {
                rating = parseInt(star.getAttribute('data-v'), 10);
                overlay.querySelectorAll('.cc-rstar').forEach(s => {
                    s.classList.toggle('active', parseInt(s.getAttribute('data-v'), 10) <= rating);
                });
            };
        });

        overlay.querySelector('#ccRCancel').onclick = () => overlay.remove();
        overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

        overlay.querySelector('#ccRSubmit').onclick = async () => {
            const email = overlay.querySelector('#ccREmail').value.trim();
            const code  = overlay.querySelector('#ccRCode').value.trim();
            const phone = overlay.querySelector('#ccRPhone').value.trim();
            const rtext = overlay.querySelector('#ccRText').value.trim();
            const errEl = overlay.querySelector('#ccRErr');

            if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                errEl.textContent = 'Please enter a valid email address.'; errEl.style.display = 'block'; return;
            }
            if (!phone) {
                errEl.textContent = 'Please enter your mobile number.'; errEl.style.display = 'block'; return;
            }
            if (!rtext) {
                errEl.textContent = 'Please describe the issue.'; errEl.style.display = 'block'; return;
            }
            errEl.style.display = 'none';

            const submitBtn = overlay.querySelector('#ccRSubmit');
            submitBtn.disabled = true; submitBtn.textContent = 'Submitting…';

            try {
                const r = await fetch('https://comex-backend.vercel.app/api/report/submit', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        businessId, conversationId,
                        email, countryCode: code, mobileNumber: phone,
                        writtenReport: rtext, botMessage: botMessageText,
                        feedbackRating: rating || null
                    })
                });
                const data = await r.json();
                if (data.success) {
                    overlay.remove();
                    if (triggerBtn) triggerBtn.classList.add('cc-reported');
                } else {
                    errEl.textContent = data.message || 'Could not submit report.'; errEl.style.display = 'block';
                    submitBtn.disabled = false; submitBtn.textContent = 'Submit Report';
                }
            } catch (err) {
                errEl.textContent = 'Connection error. Please try again.'; errEl.style.display = 'block';
                submitBtn.disabled = false; submitBtn.textContent = 'Submit Report';
            }
        };
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
        setTimeout(() => { win.style.display = 'none'; }, 300);
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

    endChatBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!humanRequestId) return;
        const ok = await ccConfirm('End this conversation with the human agent? This cannot be undone.');
        if (!ok) return;
        try {
            await fetch('https://comex-backend.vercel.app/api/human/close', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ requestId: humanRequestId, closedBy: 'user' })
            });
        } catch (err) { /* the poll loop / stopHumanPolling below still cleans up locally */ }
        stopHumanPolling('You ended this conversation.');
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
        chatBox.scrollTop = chatBox.scrollHeight;
        saveSession();

        // Once a human has been requested/connected, messages go straight into
        // that thread instead of back through the LLM — the agent (or the
        // polling loop once one connects) is who responds from here on.
        if (humanSessionActive && humanRequestId) {
            try {
                await fetch('https://comex-backend.vercel.app/api/human/send-message', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ requestId: humanRequestId, sender: 'user', text })
                });
            } catch (err) { /* the next poll cycle will still pick up any agent replies */ }
            isSending = false;
            sendBtn.disabled = false;
            inputEl.focus();
            return;
        }

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
                appendMsg('Sorry, something went wrong. Please try again.', false, { noRegenerate: true, noReport: true });
                return;
            }

            const data  = await r.json();

            // ── Human handoff signal — kicked off by this message ──
            if (data._humanRequested) {
                const reply = data.answer || data.reply || "I've flagged this for our team — someone will join shortly.";
                appendMsg(reply, false, { noRegenerate: true, noReport: true });
                chatHistory.push({ role: 'assistant', content: reply });
                humanRequestId = data._requestId || humanRequestId;
                // Fresh thread — reset dedup state so nothing bleeds over
                // from a previous (now-closed) human conversation.
                humanRenderedIds = new Set();
                humanLastPollISO = null;
                startHumanPolling();
                return;
            }

            const reply = data.answer || data.reply || "Sorry, I couldn't process that.";
            appendMsg(reply, false);
            chatHistory.push({ role: 'assistant', content: reply });
            saveSession();

        } catch (err) {
            typingEl.classList.remove('visible');
            appendMsg('Connection interrupted. Please try again.', false, { noRegenerate: true, noReport: true });
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

    // ── Restore an in-progress human conversation after a page refresh ───────
    if (humanSessionActive && humanRequestId) {
        // Replay any prior chat history bubbles (AI ones) already restored from
        // localStorage into memory — re-render them so the window looks the same.
        welcomeCard.style.display = 'none';
        chatHistory.forEach(m => {
            if (m.role === 'user') appendMsg(m.content, true);
            else if (m.role === 'assistant') appendMsg(m.content, false, { noRegenerate: true, noReport: true });
        });
        humanLastPollISO = null; // force a full replay of the human thread from the server
        startHumanPolling();
        pollHumanMessages(true);
    }
})();
