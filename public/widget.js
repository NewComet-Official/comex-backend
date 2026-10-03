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
    // The ACTIVE conversation lives in sessionStorage, so every tab / window is its own
    // visitor (private windows in the same Chrome session share localStorage, which is
    // what used to make two windows look like one user).
    // Past chats (only when the owner enables "Save Past Chats") live in localStorage.
    let chatHistory  = [];
    let savedMessages = [];
    let isSending    = false;
    let savePastChatsEnabled = false;

    const SESSION_KEY = `comex_widget_session_${businessId}`;
    const CHATS_KEY   = `comex_widget_chats_${businessId}`;

    const newConvId = () => {
        const a = new Uint32Array(3);
        crypto.getRandomValues(a);
        return `conv-${Date.now()}-${Array.from(a).map(n => n.toString(36)).join('')}`;
    };

    // Drop the old shared (localStorage) session from previous widget versions
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}

    function loadSession() {
        try {
            const raw = sessionStorage.getItem(SESSION_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    }
    function readChats() {
        try {
            const a = JSON.parse(localStorage.getItem(CHATS_KEY) || '[]');
            return Array.isArray(a) ? a : [];
        } catch (e) { return []; }
    }
    function writeChats(a) {
        try { localStorage.setItem(CHATS_KEY, JSON.stringify(a.slice(0, 30))); } catch (e) {}
    }
    function persistPastChat() {
        if (!savePastChatsEnabled) return;
        const first = savedMessages.find(m => m.k === 'user');
        if (!first) return;
        const chats = readChats().filter(c => c.id !== conversationId);
        chats.unshift({
            id: conversationId,
            title: String(first.text || 'Chat').slice(0, 40),
            updatedAt: Date.now(),
            messages: savedMessages.slice(-100),
            history: chatHistory.slice(-30),
        });
        writeChats(chats);
    }
    function saveSession() {
        try {
            sessionStorage.setItem(SESSION_KEY, JSON.stringify({
                conversationId,
                chatHistory: chatHistory.slice(-30),
                messages: savedMessages.slice(-100),
                humanSessionActive, humanRequestId, humanLastPollISO,
                humanRenderedIds: Array.from(humanRenderedIds),
            }));
        } catch (e) { /* storage may be unavailable — degrade gracefully */ }
        persistPastChat();
    }
    function clearHumanFromSession() {
        humanSessionActive = false; humanRequestId = null; humanLastPollISO = null;
        humanRenderedIds = new Set();
        saveSession();
    }

    const existingSession = loadSession();
    let conversationId = existingSession?.conversationId || newConvId();

    // ── Human handoff session state ──────────────────────────────────────────
    let humanSessionActive = !!(existingSession?.humanSessionActive && existingSession?.humanRequestId);
    let humanRequestId     = existingSession?.humanRequestId || null;
    let humanPollTimer     = null;
    let humanLastPollISO   = existingSession?.humanLastPollISO || null;
    let humanRenderedIds   = new Set(existingSession?.humanRenderedIds || []);
    let humanPollInFlight  = false;
    if (existingSession?.chatHistory?.length) chatHistory = existingSession.chatHistory;
    if (existingSession?.messages?.length) savedMessages = existingSession.messages;

    // ── Default Configuration ────────────────────────────────────────────────
    let config = {
        name: 'AI Assistant',
        position: 'bottom-right',
        logoBase64: null,
        uiWidgets: {},
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
            allowAppointmentBooking: false,
            allowHumanHandoff: true,
            allowSavePastChats: false
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
                // ── Email-only agent: do not render the widget on the website ──
                if (result.agentBuildMode === 'email') {
                    return;
                }
                config.name        = result.name        || config.name;
                config.position    = result.position    || config.position;
                config.logoBase64  = result.logoBase64  || config.logoBase64;
                config.designConfig = { ...config.designConfig, ...(result.designConfig || {}) };
                config.uiWidgets = (result.uiWidgets && typeof result.uiWidgets === 'object') ? result.uiWidgets : {};
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
    const humanHandoffEnabled = config.behaviorConfig.allowHumanHandoff !== false;
    savePastChatsEnabled = !!config.behaviorConfig.allowSavePastChats;

    // ── Position Computations ────────────────────────────────────────────────
    const positions = {
        'bottom-right': { bubble: 'bottom:24px; right:24px;', window: 'bottom:96px; right:24px; transform-origin: bottom right;' },
        'bottom-left':  { bubble: 'bottom:24px; left:24px;',  window: 'bottom:96px; left:24px; transform-origin: bottom left;'  },
        'top-right':    { bubble: 'top:24px; right:24px;',    window: 'top:96px; right:24px; transform-origin: top right;'     },
        'top-left':     { bubble: 'top:24px; left:24px;',     window: 'top:96px; left:24px; transform-origin: top left;'      }
    };
    const pos = positions[config.position] || positions['bottom-right'];

    // ── Inject Modern CSS & Micro-Interactions ───────────────────────────────
    const style = document.createElement('style');
    style.textContent = `
        @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:ital,wght@0,400;0,500;0,600;0,700;0,800&display=swap');

        #cc-widget-window, #cc-widget-window *, .cc-confirm-overlay *, .cc-report-overlay * { box-sizing: border-box; }

        #cc-widget-bubble {
            position: fixed; ${pos.bubble}
            width: 64px; height: 64px; background-color: ${themeColor};
            border-radius: 50%; display: flex; align-items: center; justify-content: center;
            cursor: pointer; color: #fff; background-size: cover; background-position: center;
            box-shadow: 0 14px 34px -8px ${themeColor}99, 0 4px 10px rgba(15,23,42,0.18), inset 0 1px 1px rgba(255,255,255,0.3);
            border: 2px solid rgba(255,255,255,0.35);
            transition: transform .35s cubic-bezier(0.34,1.56,0.64,1), box-shadow .3s ease;
            z-index: 999999; user-select: none; will-change: transform;
        }
        #cc-widget-bubble::after {
            content: ''; position: absolute; inset: -6px; border-radius: 50%;
            border: 2px solid ${themeColor}; opacity: 0; animation: ccRing 2.8s ease-out infinite; pointer-events: none;
        }
        @keyframes ccRing { 0% { transform: scale(.9); opacity: .55; } 70%,100% { transform: scale(1.35); opacity: 0; } }
        #cc-widget-bubble:hover { transform: scale(1.1) translateY(-3px); }
        #cc-widget-bubble:active { transform: scale(.93); }
        #cc-widget-bubble svg { width: 28px; height: 28px; fill: currentColor; }

        #cc-widget-window {
            position: fixed; ${pos.window}
            width: 400px; height: 680px; max-height: calc(100vh - 120px);
            background: #fff; border: 1px solid rgba(226,232,240,.9); border-radius: 26px;
            display: none; flex-direction: column; overflow: hidden;
            box-shadow: 0 30px 70px -14px rgba(15,23,42,.32), 0 0 0 1px rgba(15,23,42,.03);
            z-index: 999999; color: #0f172a; opacity: 0;
            font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            transform: scale(.94) translateY(16px); will-change: transform, opacity;
            transition: opacity .3s cubic-bezier(0.16,1,0.3,1), transform .3s cubic-bezier(0.16,1,0.3,1);
        }
        #cc-widget-window.cc-open { display: flex; opacity: 1; transform: scale(1) translateY(0); }
        #cc-widget-window.cc-closed { opacity: 0; transform: scale(.94) translateY(16px); pointer-events: none; }

        .cc-header {
            padding: 18px 20px; color: #fff; flex-shrink: 0; position: relative; overflow: hidden;
            display: flex; align-items: center; justify-content: space-between;
            background: linear-gradient(135deg, ${themeColor} 0%, ${themeColor}dd 100%);
        }
        .cc-header::before {
            content: ''; position: absolute; top: -60%; right: -20%; width: 260px; height: 260px;
            background: radial-gradient(circle, rgba(255,255,255,.22) 0%, transparent 65%); pointer-events: none;
        }
        .cc-header-left { display: flex; align-items: center; gap: 12px; position: relative; z-index: 1; min-width: 0; }
        .cc-avatar-container { position: relative; flex-shrink: 0; }
        .cc-avatar {
            width: 46px; height: 46px; border-radius: 50%; background: rgba(255,255,255,.2);
            border: 2px solid rgba(255,255,255,.45); display: flex; align-items: center; justify-content: center;
            color: #fff; box-shadow: 0 6px 16px rgba(0,0,0,.14);
        }
        .cc-avatar svg { width: 22px; height: 22px; fill: currentColor; }
        .cc-status-dot { width: 13px; height: 13px; background: #22c55e; border: 2.5px solid ${themeColor}; border-radius: 50%; position: absolute; bottom: 0; right: 0; }
        .cc-status-dot::after { content: ''; position: absolute; inset: -3px; border-radius: inherit; border: 2px solid #22c55e; animation: ccPulseGreen 2s ease-out infinite; }
        @keyframes ccPulseGreen { 0% { transform: scale(.8); opacity: 1; } 100% { transform: scale(2.2); opacity: 0; } }
        .cc-bot-title { font-weight: 800; font-size: 16px; letter-spacing: -.01em; margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .cc-bot-status { font-size: 12px; opacity: .9; font-weight: 600; }

        .cc-header-actions { display: flex; gap: 6px; position: relative; z-index: 1; }
        .cc-close-btn, .cc-endchat-btn {
            width: 34px; height: 34px; border-radius: 50%; cursor: pointer; color: #fff;
            background: rgba(255,255,255,.14); border: 1px solid rgba(255,255,255,.22);
            display: flex; align-items: center; justify-content: center; transition: all .2s cubic-bezier(0.16,1,0.3,1);
        }
        .cc-close-btn:hover { background: rgba(255,255,255,.3); transform: rotate(90deg); }
        .cc-endchat-btn:hover { background: rgba(239,68,68,.9); border-color: transparent; transform: scale(1.06); }
        .cc-close-btn svg, .cc-endchat-btn svg { width: 16px; height: 16px; stroke: currentColor; }

        /* ── Past chats menu (three-dot) ── */
        .cc-menu-btn {
            width: 34px; height: 34px; border-radius: 50%; cursor: pointer; color: #fff;
            background: rgba(255,255,255,.14); border: 1px solid rgba(255,255,255,.22);
            display: none; align-items: center; justify-content: center; transition: background .2s;
        }
        .cc-menu-btn:hover { background: rgba(255,255,255,.3); }
        .cc-menu-btn svg { width: 16px; height: 16px; }
        .cc-menu-panel {
            position: absolute; top: 68px; right: 14px; width: 260px; max-height: 340px; overflow-y: auto;
            background: #fff; border: 1px solid #e2e8f0; border-radius: 16px; padding: 8px; z-index: 5;
            box-shadow: 0 18px 40px rgba(15,23,42,.22); display: none;
        }
        .cc-menu-panel.open { display: block; animation: ccFadeIn .2s ease forwards; }
        .cc-menu-new {
            width: 100%; text-align: left; background: ${themeColor}; color: #fff; border: none;
            border-radius: 10px; padding: 10px 12px; font-family: inherit; font-weight: 700; font-size: 13px;
            cursor: pointer; margin-bottom: 6px;
        }
        .cc-menu-label { font-size: 10.5px; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; color: #94a3b8; padding: 8px 6px 4px; }
        .cc-menu-empty { font-size: 12.5px; color: #94a3b8; padding: 8px 6px; }
        .cc-menu-chat { display: flex; align-items: center; gap: 6px; padding: 9px 10px; border-radius: 10px; cursor: pointer; }
        .cc-menu-chat:hover, .cc-menu-chat.active { background: #f1f5f9; }
        .cc-menu-chat-main { flex: 1; min-width: 0; }
        .cc-menu-chat-title { font-size: 13px; font-weight: 700; color: #0f172a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .cc-menu-chat-date { font-size: 11px; color: #94a3b8; }
        .cc-menu-del { background: none; border: none; color: #94a3b8; cursor: pointer; font-size: 12px; }
        .cc-menu-del:hover { color: #ef4444; }

        .cc-confirm-overlay, .cc-report-overlay {
            position: fixed; inset: 0; background: rgba(15,23,42,.55); backdrop-filter: blur(5px);
            display: flex; align-items: center; justify-content: center; padding: 20px;
            font-family: 'Plus Jakarta Sans', -apple-system, sans-serif; animation: ccFadeIn .2s ease forwards;
        }
        .cc-confirm-overlay { z-index: 1000001; } .cc-report-overlay { z-index: 1000000; }
        .cc-confirm-card, .cc-report-card {
            background: #fff; border-radius: 22px; width: 100%; padding: 24px; transform: scale(.95);
            box-shadow: 0 24px 50px rgba(0,0,0,.25); animation: ccPopIn .25s cubic-bezier(0.34,1.56,0.64,1) forwards;
        }
        .cc-confirm-card { max-width: 320px; text-align: center; }
        .cc-report-card { max-width: 400px; max-height: 90vh; overflow-y: auto; }
        @keyframes ccPopIn { to { transform: scale(1); } }
        .cc-confirm-card p { font-size: 14.5px; font-weight: 700; margin: 0 0 20px; line-height: 1.5; }
        .cc-confirm-actions, .cc-report-actions { display: flex; gap: 10px; }
        .cc-report-actions { margin-top: 20px; }
        .cc-confirm-actions button, .cc-report-actions button { flex: 1; padding: 12px; border-radius: 12px; font-weight: 700; font-size: 13.5px; cursor: pointer; border: none; font-family: inherit; transition: all .2s; }
        .cc-confirm-cancel, .cc-rcancel { background: #f1f5f9; color: #475569; }
        .cc-confirm-cancel:hover, .cc-rcancel:hover { background: #e2e8f0; }
        .cc-confirm-ok { background: #ef4444; color: #fff; box-shadow: 0 6px 14px rgba(239,68,68,.28); }
        .cc-confirm-ok:hover { background: #dc2626; transform: translateY(-1px); }
        .cc-rsubmit { background: ${themeColor}; color: #fff; box-shadow: 0 6px 14px ${themeColor}55; }
        .cc-rsubmit:hover { transform: translateY(-1px); }
        .cc-rsubmit:disabled { opacity: .6; cursor: not-allowed; transform: none; }

        .cc-chatbox {
            flex: 1; padding: 20px 18px 10px; overflow-y: auto; display: flex; flex-direction: column; gap: 14px;
            background: linear-gradient(180deg, #f8fafc 0%, #f1f5f9 100%); scroll-behavior: smooth;
        }
        .cc-chatbox::-webkit-scrollbar { width: 6px; }
        .cc-chatbox::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 10px; }

        .cc-welcome-card {
            background: #fff; border: 1px solid #e2e8f0; border-radius: 22px; padding: 20px;
            box-shadow: 0 12px 28px -10px rgba(15,23,42,.08); animation: ccFadeIn .35s ease forwards;
        }
        .cc-welcome-card p { margin: 0 0 14px; font-size: 14px; color: #475569; line-height: 1.55; font-weight: 500; }
        .cc-suggested-grid { display: flex; flex-direction: column; gap: 8px; }
        .cc-suggested-chip {
            background: #f8fafc; border: 1px solid #e2e8f0; padding: 12px 14px; border-radius: 14px;
            font-size: 13.5px; color: #334155; cursor: pointer; font-weight: 600;
            display: flex; align-items: center; justify-content: space-between; transition: all .2s cubic-bezier(0.16,1,0.3,1);
        }
        .cc-suggested-chip:hover { background: #fff; border-color: ${themeColor}; color: ${themeColor}; transform: translateY(-2px); box-shadow: 0 8px 18px rgba(15,23,42,.08); }

        .cc-bubble-container { display: flex; flex-direction: column; width: 100%; animation: ccFadeIn .3s cubic-bezier(0.16,1,0.3,1) forwards; }
        @keyframes ccFadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }

        .cc-bubble { max-width: 84%; padding: 12px 16px; border-radius: 20px; font-size: 14px; line-height: 1.58; word-break: break-word; font-weight: 500; }
        .cc-bubble p { margin: 0 0 6px; } .cc-bubble p:last-child { margin-bottom: 0; }
        .cc-bubble ul, .cc-bubble ol { margin: 4px 0 6px 18px; padding: 0; } .cc-bubble li { margin-bottom: 3px; }
        .cc-bubble a { color: inherit; text-decoration: underline; text-underline-offset: 2px; font-weight: 700; }
        .cc-bubble code { background: rgba(15,23,42,.08); padding: 1px 6px; border-radius: 6px; font-size: .86em; }

        .cc-user { align-items: flex-end; }
        .cc-user .cc-bubble { background: linear-gradient(135deg, ${themeColor}, ${themeColor}dd); color: #fff; border-bottom-right-radius: 6px; box-shadow: 0 8px 18px -6px ${themeColor}88; }
        .cc-ai { align-items: flex-start; }
        .cc-ai .cc-bubble { background: #fff; color: #0f172a; border-bottom-left-radius: 6px; border: 1px solid #e8edf3; box-shadow: 0 6px 16px -8px rgba(15,23,42,.1); }
        .cc-agent .cc-bubble { background: #ecfdf5; color: #065f46; border-bottom-left-radius: 6px; border: 1px solid #a7f3d0; }
        .cc-system-note { align-self: center; font-size: 11.5px; color: #64748b; font-weight: 700; padding: 5px 14px; background: #e8edf3; border-radius: 100px; }

        .cc-meta-row { display: flex; align-items: center; gap: 8px; margin-top: 4px; padding: 0 6px; }
        .cc-user .cc-meta-row { flex-direction: row-reverse; }
        .cc-meta { font-size: 10.5px; color: #94a3b8; font-weight: 600; }
        .cc-msg-actions { display: flex; gap: 2px; opacity: 0; transition: opacity .2s; }
        .cc-bubble-container:hover .cc-msg-actions { opacity: 1; }
        .cc-action-btn { background: transparent; border: none; cursor: pointer; color: #94a3b8; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; border-radius: 7px; padding: 0; transition: all .15s; }
        .cc-action-btn:hover { background: #e2e8f0; color: #1e293b; transform: scale(1.1); }
        .cc-action-btn.cc-reported { color: #ef4444; }
        .cc-action-btn svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

        .cc-widget-row { align-self: flex-start; width: 100%; max-width: 330px; animation: ccFadeIn .4s cubic-bezier(0.16,1,0.3,1) forwards; }
        .cc-widget-row .cw-card input { width: 100%; padding: 10px 12px; border: 1.5px solid #e2e8f0; border-radius: 11px; margin: 4px 0 10px; font: inherit; font-size: 13px; outline: none; background: #f8fafc; transition: border-color .2s, box-shadow .2s; }
        .cc-widget-row .cw-card input:focus { border-color: ${themeColor}; background: #fff; box-shadow: 0 0 0 4px ${themeColor}1f; }
        .cc-widget-row .cw-submit:disabled { opacity: .6; cursor: not-allowed; }

        .cc-footer { padding: 14px 16px 10px; background: #fff; border-top: 1px solid #eef2f6; display: flex; gap: 10px; align-items: center; flex-shrink: 0; }
        .cc-input-wrapper { flex: 1; position: relative; display: flex; align-items: center; }
        .cc-input {
            width: 100%; background: #f1f5f9; border: 1.5px solid transparent; color: #0f172a; outline: none; font-family: inherit;
            padding: ${typebarSize === 'large' ? '15px 46px 15px 18px' : '12px 46px 12px 18px'};
            font-size: 14px; border-radius: 100px; font-weight: 500; transition: all .2s ease;
        }
        .cc-input::placeholder { color: #94a3b8; }
        .cc-input:focus { border-color: ${themeColor}; background: #fff; box-shadow: 0 0 0 4px ${themeColor}1f; }
        .cc-send-btn {
            background: ${themeColor}; border: none; color: #fff; cursor: pointer; display: flex; align-items: center; justify-content: center;
            padding: ${sendButtonStyle === 'pill' ? '0 22px' : '0'}; width: ${sendButtonStyle === 'pill' ? 'auto' : '46px'}; height: 46px;
            border-radius: ${sendButtonStyle === 'pill' ? '23px' : '50%'}; font-weight: 700; font-family: inherit; font-size: 13.5px; flex-shrink: 0;
            box-shadow: 0 8px 18px -6px ${themeColor}99; transition: all .2s cubic-bezier(0.16,1,0.3,1);
        }
        .cc-send-btn svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; transition: transform .2s; }
        .cc-send-btn:hover:not(:disabled) { transform: scale(1.07); } .cc-send-btn:hover:not(:disabled) svg { transform: translateX(2px); }
        .cc-send-btn:active:not(:disabled) { transform: scale(.94); }
        .cc-send-btn:disabled { opacity: .4; cursor: not-allowed; box-shadow: none; }

        .cc-mic-btn { position: absolute; right: 10px; background: none; border: none; color: #64748b; cursor: pointer; padding: 6px; display: ${voiceEnabled ? 'flex' : 'none'}; align-items: center; justify-content: center; border-radius: 50%; transition: all .2s; }
        .cc-mic-btn:hover { color: #0f172a; background: #e2e8f0; }
        .cc-mic-btn svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2; }
        .cc-mic-btn.recording { color: #ef4444; background: #fef2f2; animation: ccPulse 1.4s infinite; }
        @keyframes ccPulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.12); } }

        .cc-typing { display: none; align-self: flex-start; background: #fff; border: 1px solid #e8edf3; padding: 13px 18px; border-radius: 20px; border-bottom-left-radius: 6px; gap: 5px; align-items: center; box-shadow: 0 6px 16px -8px rgba(15,23,42,.1); }
        .cc-typing.visible { display: flex; animation: ccFadeIn .25s ease forwards; }
        .cc-dot { width: 7px; height: 7px; border-radius: 50%; background: ${themeColor}; opacity: .55; animation: ccBounce 1.4s ease-in-out infinite; }
        .cc-dot:nth-child(2) { animation-delay: .2s; } .cc-dot:nth-child(3) { animation-delay: .4s; }
        @keyframes ccBounce { 0%,80%,100% { transform: translateY(0); } 40% { transform: translateY(-6px); } }

        .cc-brand-footer { text-align: center; font-size: 11px; color: #94a3b8; padding: 0 0 12px; background: #fff; font-weight: 600; }
        .cc-brand-footer a { color: #64748b; text-decoration: none; font-weight: 800; } .cc-brand-footer a:hover { color: ${themeColor}; }

        .cc-report-card h3 { margin: 0 0 4px; font-size: 17px; font-weight: 800; }
        .cc-report-card p.cc-rsub { margin: 0 0 16px; font-size: 12.5px; color: #64748b; font-weight: 500; }
        .cc-rfield { margin-bottom: 14px; }
        .cc-rfield label { display: block; font-size: 11px; font-weight: 800; color: #334155; margin-bottom: 6px; text-transform: uppercase; letter-spacing: .04em; }
        .cc-rfield input, .cc-rfield textarea { width: 100%; border: 1.5px solid #e2e8f0; border-radius: 11px; padding: 10px 12px; font-family: inherit; font-size: 13.5px; outline: none; resize: vertical; transition: border-color .2s; }
        .cc-rfield input:focus, .cc-rfield textarea:focus { border-color: ${themeColor}; }
        .cc-rfield textarea[readonly] { background: #f8fafc; color: #64748b; }
        .cc-rphone-row { display: flex; gap: 8px; } .cc-rphone-row input:first-child { width: 78px; flex-shrink: 0; }
        .cc-rstars { display: flex; gap: 6px; }
        .cc-rstar { font-size: 24px; cursor: pointer; color: #cbd5e1; user-select: none; transition: color .15s, transform .15s; }
        .cc-rstar.active { color: #f59e0b; } .cc-rstar:hover { transform: scale(1.2); }
        .cc-rerror { color: #ef4444; font-size: 12px; font-weight: 700; margin-bottom: 12px; display: none; }

        @media (prefers-reduced-motion: reduce) { #cc-widget-bubble::after, .cc-status-dot::after { animation: none; } }
        @media (max-width: 480px) {
            #cc-widget-window { width: 100% !important; height: 100% !important; max-height: 100vh !important; inset: 0 !important; border-radius: 0 !important; transform: translateY(100%); }
            #cc-widget-window.cc-open { transform: translateY(0); }
            #cc-widget-window.cc-closed { transform: translateY(100%); opacity: 0; }
            .cc-bubble { max-width: 90%; }
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
    if (config.logoBase64) {
        avatar.style.backgroundImage = `url('${config.logoBase64}')`;
        avatar.style.backgroundSize = 'cover';
        avatar.style.backgroundPosition = 'center';
    } else {
        avatar.innerHTML = `<svg viewBox="0 0 24 24"><path d="M12 2c-4.97 0-9 4.03-9 9 0 2.12.74 4.07 1.97 5.61L4.35 19.4c-.39.39-.39 1.02 0 1.41.39.39 1.02.39 1.41 0l2.79-2.79C10.09 18.64 11.03 19 12 19c4.97 0 9-4.03 9-9s-4.03-9-9-9zm0 15c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6-2.69 6-6 6zm-2-7c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm4 0c-.55 0-1 .45-1 1s.45 1 1 1 1-.45 1-1-.45-1-1-1zm-4 4h4c.55 0 1-.45 1-1s-.45-1-1-1h-4c-.55 0-1 .45-1 1s.45 1 1 1z"/></svg>`;
    }
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

    // Three-dot past-chats menu (only shown when "Save Past Chats" is enabled)
    const menuBtn = document.createElement('button');
    menuBtn.className = 'cc-menu-btn';
    menuBtn.setAttribute('aria-label', 'Past chats');
    menuBtn.title = 'Past chats';
    menuBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>`;
    if (savePastChatsEnabled) menuBtn.style.display = 'flex';
    const menuPanel = document.createElement('div');
    menuPanel.className = 'cc-menu-panel';

    headerActions.appendChild(menuBtn);
    headerActions.appendChild(endChatBtn);
    headerActions.appendChild(closeBtn);
    header.appendChild(headerLeft);
    header.appendChild(headerActions);
    win.appendChild(header);
    win.appendChild(menuPanel);

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
            <div class="cc-suggested-chip" data-msg="What services do you offer?">
              <span>
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: text-bottom; margin-right: 6px;"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .6 2.2 1.5 3.1.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>
                What services do you offer?
              </span> 
              ➔
            </div> 
            ${humanHandoffEnabled ? `
            <div class="cc-suggested-chip" data-msg="Speak to human support">
              <span>
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: text-bottom; margin-right: 6px;"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                Connect to human agent
              </span> 
              ➔
            </div>` : ''}
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
        let t = String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
             .replace(/(^|[^*])\*(?!\*)([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
             .replace(/`([^`]+)`/g, '<code>$1</code>')
             .replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)]/g, u => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
        let html = '', list = [], type = null;
        const flush = () => { if (list.length) { html += `<${type}>${list.map(i => `<li>${i}</li>`).join('')}</${type}>`; list = []; type = null; } };
        t.split('\n').forEach(line => {
            const b = line.match(/^\s*[-*•]\s+(.*)/), n = line.match(/^\s*\d+[.)]\s+(.*)/);
            if (b || n) { const want = b ? 'ul' : 'ol'; if (type && type !== want) flush(); type = want; list.push((b || n)[1]); }
            else { flush(); if (line.trim()) html += `<p>${line.trim()}</p>`; }
        });
        flush();
        return html;
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

    // ── Custom confirm dialog ────────────────────────────────────────────────
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

        // Remember what's on screen so the chat can be restored / saved as a past chat
        if (!opts.noSave) {
            savedMessages.push({ k: isUser ? 'user' : (opts.isAgent ? 'agent' : 'bot'), text: String(text || '') });
        }

        const container = document.createElement('div');
        container.className = `cc-bubble-container ${isUser ? 'cc-user' : (opts.isAgent ? 'cc-agent' : 'cc-ai')}`;

        const bubbleEl = document.createElement('div');
        bubbleEl.className = 'cc-bubble';

        if (isUser) {
            bubbleEl.textContent = text;
        } else {
            bubbleEl.innerHTML = (opts.isAgent ? '<strong>' + iconHtml('svg:user') + ' Human Agent:</strong> ' : '') + parseMarkdown(text);
        }
        container.appendChild(bubbleEl);

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

    // ── Past chats: menu, switch, continue ───────────────────────────────────
    const escM = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    function resetChatUI() {
        chatBox.querySelectorAll('.cc-bubble-container, .cc-widget-row, .cc-system-note').forEach(n => n.remove());
    }
    function renderSaved(m) {
        appendMsg(m.text, m.k === 'user', { noSave: true, isAgent: m.k === 'agent', noRegenerate: true, noReport: m.k !== 'bot' });
    }
    function closeMenu() { menuPanel.classList.remove('open'); }
    function renderMenu() {
        const chats = readChats();
        menuPanel.innerHTML =
            `<button class="cc-menu-new" data-act="new">＋ New chat</button><div class="cc-menu-label">Past chats</div>` +
            (chats.length
                ? chats.map(c => `<div class="cc-menu-chat ${c.id === conversationId ? 'active' : ''}" data-id="${escM(c.id)}">
                    <div class="cc-menu-chat-main">
                        <div class="cc-menu-chat-title">${escM(c.title)}</div>
                        <div class="cc-menu-chat-date">${escM(new Date(c.updatedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</div>
                    </div>
                    <button class="cc-menu-del" data-del="${escM(c.id)}" aria-label="Delete chat">✕</button>
                </div>`).join('')
                : `<div class="cc-menu-empty">No saved chats yet.</div>`);
    }
    function canSwitchChat() {
        if (humanSessionActive) {
            appendSystemNote('End the live conversation before switching chats.');
            closeMenu();
            return false;
        }
        return !isSending;
    }
    function startNewChat() {
        if (!canSwitchChat()) return;
        conversationId = newConvId();
        chatHistory = [];
        savedMessages = [];
        resetChatUI();
        welcomeCard.style.display = '';
        saveSession();
        closeMenu();
    }
    function loadPastChat(id) {
        if (!canSwitchChat()) return;
        const c = readChats().find(x => x.id === id);
        if (!c) return;
        conversationId = c.id;
        chatHistory = (c.history || []).slice();
        savedMessages = (c.messages || []).slice();
        resetChatUI();
        welcomeCard.style.display = 'none';
        savedMessages.forEach(renderSaved);
        saveSession();
        closeMenu();
    }

    menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (menuPanel.classList.contains('open')) { closeMenu(); return; }
        renderMenu();
        menuPanel.classList.add('open');
    });
    menuPanel.addEventListener('click', (e) => {
        e.stopPropagation();
        const del = e.target.closest('[data-del]');
        if (del) { writeChats(readChats().filter(c => c.id !== del.dataset.del)); renderMenu(); return; }
        if (e.target.closest('[data-act="new"]')) { startNewChat(); return; }
        const row = e.target.closest('.cc-menu-chat');
        if (row) loadPastChat(row.dataset.id);
    });
    win.addEventListener('click', closeMenu);

    // ── Widget Studio cards (designed in the dashboard) ──────────────────────
    const escW = v => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const colW = (c, d) => /^#[0-9a-f]{3,8}$/i.test(c || '') ? c : d;

    // ── SVG icons / image icons / custom-HTML widgets (parity with Widget Studio) ──
    const SVG_PATHS = {
        check:'<circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/>',
        user:'<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
        package:'<path d="m21 8-9-5-9 5 9 5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
        form:'<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
        chat:'<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
        tag:'<path d="M20 13 13 20a2 2 0 0 1-3 0L3 13V3h10l7 7a2 2 0 0 1 0 3z"/><circle cx="7.5" cy="7.5" r="1"/>',
        book:'<path d="M4 19V5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2z"/><path d="M8 7h8"/>',
        plug:'<path d="M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v5"/>',
        rocket:'<path d="M5 15c-1 1-2 4-2 6 2 0 5-1 6-2"/><path d="M12 15 9 12c1-5 5-9 12-9 0 7-4 11-9 12z"/><circle cx="15" cy="9" r="1"/>',
        bell:'<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a2 2 0 0 0 3.4 0"/>',
        alert:'<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
        stop:'<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
        clock:'<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
        bolt:'<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
        headset:'<path d="M3 14v-2a9 9 0 0 1 18 0v2"/><rect x="2" y="14" width="4" height="6" rx="1"/><rect x="18" y="14" width="4" height="6" rx="1"/>',
        trend:'<path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>',
        bag:'<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
        star:'<path d="m12 2 3 6.9 7.5.6-5.7 4.9 1.8 7.3L12 17.8 5.4 21.7l1.8-7.3L1.5 9.5 9 8.9z"/>',
        calendar:'<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
        heart:'<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/>',
        gift:'<rect x="3" y="8" width="18" height="4"/><path d="M12 8v13M19 12v9H5v-9"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5"/>',
        mail:'<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>'
    };
    const iconHtml = v => {
        v = String(v == null ? '' : v);
        if (v.startsWith('svg:') && SVG_PATHS[v.slice(4)])
            return `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-0.125em">${SVG_PATHS[v.slice(4)]}</svg>`;
        if (/^(data:image\/|https?:\/\/)/i.test(v))
            return `<img src="${v.replace(/"/g, '&quot;')}" alt="" style="width:100%;height:100%;object-fit:contain;border-radius:6px;">`;
        return escW(v);
    };
    function customWidgetHtml(def, ctx) {
        ctx = ctx || {};
        const raw = String((def.config || {}).html || '').replace(/\{\{(\w+)\}\}/g, (m, k) => ctx[k] !== undefined ? escW(ctx[k]) : '');
        const d = '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;font-family:inherit}</style></head><body>' + raw +
            '<script>window.sendToChat=function(t){parent.postMessage({ccSend:String(t)},"*")};function h(){parent.postMessage({ccHeight:document.documentElement.scrollHeight},"*")}try{new ResizeObserver(h).observe(document.body)}catch(e){}addEventListener("load",h);<\/script></body></html>';
        return `<iframe class="cw-custom" sandbox="allow-scripts allow-forms" srcdoc="${d.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" style="width:100%;max-width:340px;height:120px;border:0;background:transparent;display:block;"></iframe>`;
    }
    window.addEventListener('message', e => {
        if (!e.data) return;
        const fr = Array.from(document.querySelectorAll('iframe.cw-custom')).find(f => f.contentWindow === e.source);
        if (!fr) return;
        if (e.data.ccHeight) fr.style.height = Math.min(800, Math.max(40, e.data.ccHeight)) + 'px';
        if (typeof e.data.ccSend === 'string' && fr.__send) fr.__send(e.data.ccSend);
    });


    function widgetToHtml(def, ctx) {
        if ((def.config || {}).mode === 'custom') return customWidgetHtml(def, ctx);
        ctx = ctx || {};
        const c = def.config || {};
        const accent = colW(c.accent, '#5b3df5'), bg = colW(c.bg, '#ffffff'), tx = colW(c.text, '#15121f');
        const r = Math.max(0, Math.min(32, parseInt(c.radius, 10) || 16));
        const t = v => escW(String(v || '').replace(/\{\{(\w+)\}\}/g, (m, k) => ctx[k] !== undefined ? ctx[k] : ''));
        let body = '';
        if (def.category === 'appointment_form') {
            body = (c.fields || []).map(f => `<label style="font-size:.74rem;font-weight:700;display:block;">${escW(f.label)}<input data-key="${escW(f.key)}" type="${['date','time','email','number'].includes(f.type) ? f.type : 'text'}"></label>`).join('') +
                `<button type="button" class="cw-submit" style="width:100%;padding:12px;border:none;border-radius:${Math.min(r, 14)}px;background:${accent};color:#fff;font-weight:800;font-family:inherit;cursor:pointer;">${t(c.button || 'Submit')}</button>`;
        } else if (def.category === 'tracker') {
            const cur = parseInt(ctx.step, 10), steps = c.steps || [];
            body = `<div style="display:flex;justify-content:space-between;margin:10px 0 12px;">${steps.map((s, i) => `<div style="flex:1;text-align:center;font-size:.68rem;font-weight:700;opacity:${i <= cur ? 1 : .45};"><div style="width:14px;height:14px;border-radius:50%;margin:0 auto 5px;background:${i <= cur ? accent : '#d2d3ea'};"></div>${escW(s)}</div>`).join('')}</div>` +
                (c.fields || []).map(f => `<div style="display:flex;justify-content:space-between;font-size:.8rem;padding:3px 0;"><span style="opacity:.65;">${escW(f.label)}</span><strong>${t('{{' + f.key + '}}')}</strong></div>`).join('');
        } else {
            body = (c.fields || []).map(f => `<div style="display:flex;justify-content:space-between;gap:10px;font-size:.82rem;padding:5px 0;border-bottom:1px solid ${accent}22;"><span style="opacity:.65;">${escW(f.label)}</span><strong style="text-align:right;">${t('{{' + f.key + '}}')}</strong></div>`).join('');
            if (c.button) body += `<div style="margin-top:10px;text-align:center;padding:9px;border-radius:10px;background:${accent};color:#fff;font-weight:800;font-size:.8rem;">${t(c.button)}</div>`;
        }
        return `<div class="cw-card" style="width:100%;background:${bg};color:${tx};border-radius:${r}px;border:1px solid ${accent}44;box-shadow:0 10px 26px -10px ${accent}66;overflow:hidden;font-family:inherit;">
            <div style="background:${accent};color:#fff;padding:14px 16px;display:flex;gap:10px;align-items:center;"><span style="font-size:1.4rem;display:inline-flex;width:28px;height:28px;align-items:center;justify-content:center;">${iconHtml(c.icon)}</span><div><div style="font-weight:800;font-size:.95rem;">${t(c.title)}</div><div style="font-size:.76rem;opacity:.9;">${t(c.subtitle)}</div></div></div>
            <div style="padding:14px 16px;">${body}${c.footer ? `<div style="margin-top:10px;font-size:.72rem;opacity:.65;">${t(c.footer)}</div>` : ''}</div></div>`;
    }

    function appendWidget(def, ctx) {
        const row = document.createElement('div');
        row.className = 'cc-widget-row';
        row.innerHTML = widgetToHtml(def, ctx);
        const _cf = row.querySelector('iframe.cw-custom');
        if (_cf) _cf.__send = t => { inputEl.value = t; sendMessage(); };
        const btn = row.querySelector('.cw-submit');
        if (btn) btn.onclick = () => {
            const v = {};
            row.querySelectorAll('input[data-key]').forEach(i => { v[i.dataset.key] = i.value.trim(); });
            if (!v.name || !v.contact || !v.date || !v.time) { btn.textContent = 'Please fill every field'; setTimeout(() => { btn.textContent = (def.config && def.config.button) || 'Submit'; }, 1600); return; }
            btn.disabled = true; btn.textContent = 'Sending…';
            inputEl.value = `My name is ${v.name}. My contact is ${v.contact}. I'd like to book an appointment on ${v.date} at ${v.time}.`;
            sendMessage();
        };
        chatBox.insertBefore(row, typingEl);
        chatBox.scrollTop = chatBox.scrollHeight;
    }

    function renderBotWidgets(reply, data, userMsg) {
        const defs = config.uiWidgets || {};
        const first = c => (defs[c] || [])[0];
        const pick = (c, id) => (defs[c] || []).find(d => d.id === id) || first(c);
        const w = data && data._widget;
        if (w && w.category && pick(w.category, w.id)) { appendWidget(pick(w.category, w.id), w.ctx || {}); return; }
        if (/APPOINTMENT BOOKED/.test(reply) && first('appointment_booked')) {
            const g = re => (reply.match(re) || [])[1] || '';
            appendWidget(first('appointment_booked'), { date: g(/Date:\s*(.+)/), time: g(/Time:\s*(.+)/), name: g(/Name:\s*(.+)/), contact: g(/Contact:\s*(.+)/) });
            return;
        }
        if (first('appointment_form') && config.behaviorConfig.allowAppointmentBooking && /\b(book|appointment|schedule|reserve)\b/i.test(userMsg || '')) appendWidget(first('appointment_form'), {});
    }

    // ── Human handoff: poll for agent replies ────────────────────────────────
    function startHumanPolling() {
        if (!humanHandoffEnabled) return;
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
        if (!humanHandoffEnabled || !humanRequestId || humanPollInFlight) return;
        humanPollInFlight = true;
        try {
            const url = `https://comex-backend.vercel.app/api/human/poll?requestId=${encodeURIComponent(humanRequestId)}` +
                        (humanLastPollISO ? `&sinceTs=${encodeURIComponent(humanLastPollISO)}` : '');
            const r = await fetch(url);
            const data = await r.json();
            if (!data.success) return;

            if (data.status === 'active') {
                statusEl.textContent = 'A team member has joined';
                if (!humanRenderedIds.has('__joined_widget') && ((config.uiWidgets || {}).human_joined || []).length) {
                    humanRenderedIds.add('__joined_widget');
                    const agentName = data.agentEmail ? String(data.agentEmail).split('@')[0] : 'A team member';
                    appendWidget(config.uiWidgets.human_joined[0], { agent: agentName });
                }
            } else if (data.status === 'pending') {
                statusEl.textContent = 'Waiting for a team member…';
            }

            (data.messages || []).forEach(m => {
                humanLastPollISO = m.createdAt;
                if (humanRenderedIds.has(m.id)) return;
                humanRenderedIds.add(m.id);

                if (m.sender === 'agent' && !m.isSystem) {
                    appendMsg(m.text, false, { isAgent: true, noRegenerate: true, noReport: true });
                } else if (m.sender === 'agent' && m.isSystem) {
                    appendSystemNote(m.text);
                }
                // visitor's own messages are already on screen / in savedMessages
            });
            saveSession();

            if (data.status === 'closed') {
                stopHumanPolling("This conversation was closed — you're chatting with the AI assistant again.");
            }
        } catch (err) { /* silent — retry next tick */ }
        finally {
            humanPollInFlight = false;
        }
    }

    // ── Regenerate Answer ────────────────────────────────────────────────────
    async function regenerateAnswer(container, bubbleEl, metaRow) {
        let lastUserContent = null;
        for (let i = chatHistory.length - 1; i >= 0; i--) {
            if (chatHistory[i].role === 'user') { lastUserContent = chatHistory[i].content; break; }
        }
        if (!lastUserContent) return;

        bubbleEl.innerHTML = '<p style="opacity:.6;">Regenerating…</p>';

        try {
            const historyForCall = chatHistory.slice(0, -1);
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
            for (let i = savedMessages.length - 1; i >= 0; i--) {
                if (savedMessages[i].k === 'bot') { savedMessages[i].text = reply; break; }
            }
            saveSession();
        } catch (err) {
            bubbleEl.innerHTML = '<p>Could not regenerate. Please try again.</p>';
        }
    }

    // ── Report Modal ────────────────────────────────────────────────────────
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

    // ── Widget Handlers ──────────────────────────────────────────────────────
    function openWidget() {
        win.style.display = 'flex';
        requestAnimationFrame(() => {
            win.classList.remove('cc-closed');
            win.classList.add('cc-open');
            inputEl.focus();
        });
    }

    function closeWidget() {
        closeMenu();
        win.classList.remove('cc-open');
        win.classList.add('cc-closed');
        setTimeout(() => { if (win.classList.contains('cc-closed')) win.style.display = 'none'; }, 300);
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
        } catch (err) { /* silent cleanup */ }
        stopHumanPolling('You ended this conversation.');
    });

    // ── Onboarding Chip Listeners ────────────────────────────────────────────
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

        if (humanHandoffEnabled && humanSessionActive && humanRequestId) {
            try {
                await fetch('https://comex-backend.vercel.app/api/human/send-message', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ requestId: humanRequestId, sender: 'user', text })
                });
            } catch (err) { /* handled by next poll tick */ }
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
                appendMsg('Sorry, something went wrong. Please try again.', false, { noRegenerate: true, noReport: true, noSave: true });
                return;
            }

            const data = await r.json();

            if (humanHandoffEnabled && data._humanRequested) {
                const reply = data.answer || data.reply || "I've flagged this for our team — someone will join shortly.";
                appendMsg(reply, false, { noRegenerate: true, noReport: true });
                chatHistory.push({ role: 'assistant', content: reply });
                humanRequestId = data._requestId || humanRequestId;
                humanRenderedIds = new Set();
                humanLastPollISO = null;
                startHumanPolling();
                return;
            }

            const reply = data.answer || data.reply || "Sorry, I couldn't process that.";
            appendMsg(reply, false);
            renderBotWidgets(reply, data, text);
            chatHistory.push({ role: 'assistant', content: reply });
            saveSession();

        } catch (err) {
            typingEl.classList.remove('visible');
            appendMsg('Connection interrupted. Please try again.', false, { noRegenerate: true, noReport: true, noSave: true });
        } finally {
            isSending = false;
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

    // ── Restore this tab's conversation after a refresh ──────────────────────
    if (savedMessages.length) {
        welcomeCard.style.display = 'none';
        savedMessages.forEach(renderSaved);
    }
    if (humanHandoffEnabled && humanSessionActive && humanRequestId) {
        humanLastPollISO = null;
        startHumanPolling();
        pollHumanMessages(true);
    } else if (humanSessionActive) {
        clearHumanFromSession();
    }
})();
