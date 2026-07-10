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
    let unreadCount    = 0;
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
        'bottom-right': { bubble: 'bottom:28px; right:28px;', window: 'bottom:102px; right:28px; transform-origin: bottom right;' },
        'bottom-left':  { bubble: 'bottom:28px; left:28px;',  window: 'bottom:102px; left:28px; transform-origin: bottom left;'  },
        'top-right':    { bubble: 'top:28px; right:28px;',    window: 'top:102px; right:28px; transform-origin: top right;'     },
        'top-left':     { bubble: 'top:28px; left:28px;',     window: 'top:102px; left:28px; transform-origin: top left;'      }
    };
    const pos = positions[config.position] || positions['bottom-right'];

    // ── Inject Premium Styles ────────────────────────────────────────────────
    const style = document.createElement('style');
    style.textContent = `
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Inter+Tight:wght@600;700&display=swap');

        :root {
            --cc-theme: ${themeColor};
            --cc-theme-soft: color-mix(in srgb, ${themeColor} 14%, transparent);
            --cc-theme-softer: color-mix(in srgb, ${themeColor} 7%, transparent);
            --cc-theme-tint: color-mix(in srgb, ${themeColor} 88%, white);
            --cc-theme-deep: color-mix(in srgb, ${themeColor} 82%, black);
            --cc-surface: #ffffff;
            --cc-surface-2: #f8fafc;
            --cc-ink: #0f172a;
            --cc-ink-soft: #475569;
            --cc-ink-faint: #94a3b8;
            --cc-line: #e7eaef;
            --cc-radius-window: 26px;
            --cc-ease-spring: cubic-bezier(0.22, 1.12, 0.32, 1);
            --cc-ease-out: cubic-bezier(0.16, 1, 0.3, 1);
        }
        @media (prefers-color-scheme: dark) {
            #cc-widget-window {
                --cc-surface: #14171f;
                --cc-surface-2: #0c0e13;
                --cc-ink: #f1f5f9;
                --cc-ink-soft: #b6bfcd;
                --cc-ink-faint: #6b7484;
                --cc-line: #262b36;
            }
            .cc-ai .cc-bubble { background: #1b1f29 !important; border-color: #2a303c !important; color: var(--cc-ink) !important; }
            .cc-input { background: #1a1e27 !important; border-color: #2a303c !important; color: var(--cc-ink) !important; }
            .cc-welcome-card { background: #1b1f29 !important; border-color: #2a303c !important; }
            .cc-suggested-chip { background: #1f2430 !important; border-color: #2a303c !important; color: #dbe2ee !important; }
            .cc-typing { background: #1b1f29 !important; border-color: #2a303c !important; }
            .cc-footer { background: var(--cc-surface) !important; border-top-color: var(--cc-line) !important; }
        }

        #cc-widget-bubble {
            position: fixed; ${pos.bubble}
            width: 60px; height: 60px; background: var(--cc-theme);
            background-image: linear-gradient(155deg, color-mix(in srgb, ${themeColor} 100%, white 14%) 0%, ${themeColor} 55%, var(--cc-theme-deep) 100%);
            border-radius: 20px; display: flex; align-items: center; justify-content: center;
            cursor: pointer; box-shadow: 0 10px 30px -6px color-mix(in srgb, ${themeColor} 45%, transparent), 0 2px 8px rgba(15,23,42,0.12), inset 0 1px 0 rgba(255,255,255,0.16);
            transition: transform 0.45s var(--cc-ease-spring), box-shadow 0.35s var(--cc-ease-out), border-radius 0.35s var(--cc-ease-out);
            z-index: 999999; user-select: none; color: #fff; background-size: cover; background-position: center;
            border: 1px solid rgba(255,255,255,0.08); will-change: transform;
        }
        #cc-widget-bubble:hover { transform: scale(1.05) translateY(-2px); border-radius: 24px; box-shadow: 0 16px 36px -6px color-mix(in srgb, ${themeColor} 55%, transparent), 0 4px 10px rgba(15,23,42,0.14); }
        #cc-widget-bubble:active { transform: scale(0.94); }
        #cc-widget-bubble:focus-visible { outline: 2px solid #fff; outline-offset: 3px; }
        #cc-widget-bubble svg { width: 25px; height: 25px; fill: currentColor; transition: transform 0.4s var(--cc-ease-spring); }
        #cc-widget-bubble.cc-active svg { transform: rotate(90deg) scale(0.92); }
        #cc-widget-bubble:hover svg:not(.cc-icon-close) { transform: rotate(-6deg) scale(1.04); }

        .cc-unread-badge {
            position: absolute; top: -4px; right: -4px; min-width: 20px; height: 20px; padding: 0 5px;
            background: #ef4444; color: #fff; font: 700 11px/20px 'Inter', sans-serif; text-align: center;
            border-radius: 999px; border: 2px solid var(--cc-surface, #fff); box-shadow: 0 2px 6px rgba(239,68,68,0.5);
            transform: scale(0); transition: transform 0.35s var(--cc-ease-spring);
        }
        .cc-unread-badge.cc-show { transform: scale(1); }

        #cc-widget-window {
            position: fixed; ${pos.window}
            width: 392px; height: 632px; background: var(--cc-surface);
            border: 1px solid var(--cc-line); border-radius: var(--cc-radius-window); display: none;
            flex-direction: column; overflow: hidden;
            box-shadow: 0 30px 70px -18px rgba(15,23,42,0.28), 0 8px 24px -8px rgba(15,23,42,0.12);
            z-index: 999999; font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
            color: var(--cc-ink); will-change: transform, opacity; opacity: 0;
            transition: opacity 0.3s var(--cc-ease-out), transform 0.4s var(--cc-ease-spring);
        }
        #cc-widget-window.cc-open { display: flex; opacity: 1; transform: scale(1) translateY(0); }
        #cc-widget-window.cc-closed { transform: scale(0.9) translateY(18px); opacity: 0; }
        @media (prefers-reduced-motion: reduce) {
            #cc-widget-window, #cc-widget-bubble, .cc-bubble-container, .cc-unread-badge { transition: none !important; animation: none !important; }
        }

        .cc-header {
            padding: 22px 22px 20px; color: #fff; flex-shrink: 0; position: relative; overflow: hidden;
            background: var(--cc-theme);
        }
        .cc-header-aura {
            position: absolute; inset: -40%; pointer-events: none; opacity: 0.9; filter: blur(0px);
            background:
                radial-gradient(circle at 18% 20%, color-mix(in srgb, ${themeColor} 40%, white 35%) 0%, transparent 42%),
                radial-gradient(circle at 82% 78%, color-mix(in srgb, ${themeColor} 60%, black 10%) 0%, transparent 48%),
                radial-gradient(circle at 60% 0%, color-mix(in srgb, ${themeColor} 30%, white 45%) 0%, transparent 38%);
            animation: ccAuraDrift 16s ease-in-out infinite alternate;
        }
        @keyframes ccAuraDrift {
            0%   { transform: translate(0, 0) rotate(0deg) scale(1); }
            100% { transform: translate(3%, -2%) rotate(6deg) scale(1.08); }
        }
        .cc-header-row { display: flex; align-items: center; justify-content: space-between; position: relative; z-index: 1; }
        .cc-header-left { display: flex; align-items: center; gap: 13px; }
        .cc-avatar-container { position: relative; flex-shrink: 0; }
        .cc-avatar {
            width: 44px; height: 44px; border-radius: 14px;
            background: rgba(255,255,255,0.14); border: 1px solid rgba(255,255,255,0.28);
            display: flex; align-items: center; justify-content: center; color: #fff;
            box-shadow: 0 4px 14px rgba(0,0,0,0.14), inset 0 1px 0 rgba(255,255,255,0.2);
            background-size: cover; background-position: center; overflow: hidden;
        }
        .cc-avatar svg { width: 22px; height: 22px; fill: currentColor; }
        .cc-status-dot {
            width: 10px; height: 10px; background: #22c55e; border: 2.5px solid var(--cc-theme);
            border-radius: 50%; position: absolute; bottom: -2px; right: -2px;
        }
        .cc-status-dot::after {
            content: ''; position: absolute; inset: -3px; border-radius: inherit;
            border: 1.5px solid #22c55e; animation: ccPulseGreen 2.4s ease-out infinite;
        }
        @keyframes ccPulseGreen { 0% { transform: scale(0.9); opacity: 0.9; } 100% { transform: scale(2.2); opacity: 0; } }

        .cc-bot-title { font-family: 'Inter Tight', 'Inter', sans-serif; font-weight: 700; font-size: 15.5px; letter-spacing: -0.015em; margin-bottom: 3px; }
        .cc-bot-status { font-size: 12px; opacity: 0.88; font-weight: 500; display: flex; align-items: center; gap: 5px; letter-spacing: -0.005em; }
        .cc-bot-status::before { content: ''; width: 5px; height: 5px; border-radius: 50%; background: #4ade80; box-shadow: 0 0 0 2px rgba(255,255,255,0.15); }

        .cc-close-btn {
            background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: #fff; opacity: 0.9;
            transition: all 0.25s var(--cc-ease-out); cursor: pointer; width: 32px; height: 32px; border-radius: 10px;
            display: flex; align-items: center; justify-content: center; position: relative; z-index: 1;
        }
        .cc-close-btn:hover { opacity: 1; background: rgba(255,255,255,0.18); transform: rotate(90deg); }
        .cc-close-btn:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
        .cc-close-btn svg { width: 15px; height: 15px; stroke: currentColor; }

        .cc-chatbox {
            flex: 1; padding: 20px 20px 16px; overflow-y: auto; display: flex;
            flex-direction: column; gap: 14px; background: var(--cc-surface-2); scroll-behavior: smooth;
        }
        .cc-chatbox::-webkit-scrollbar { width: 5px; }
        .cc-chatbox::-webkit-scrollbar-track { background: transparent; }
        .cc-chatbox::-webkit-scrollbar-thumb { background: var(--cc-line); border-radius: 10px; }
        .cc-chatbox::-webkit-scrollbar-thumb:hover { background: var(--cc-ink-faint); }

        .cc-welcome-card {
            background: var(--cc-surface); border: 1px solid var(--cc-line); border-radius: 18px;
            padding: 18px; margin-bottom: 2px;
            box-shadow: 0 6px 18px -8px rgba(15,23,42,0.08);
            animation: ccFadeIn 0.4s var(--cc-ease-out) both;
        }
        .cc-welcome-card p { margin: 0 0 13px 0; font-size: 13.5px; color: var(--cc-ink-soft); line-height: 1.55; letter-spacing: -0.003em; }
        .cc-suggested-grid { display: flex; flex-direction: column; gap: 7px; }
        .cc-suggested-chip {
            background: var(--cc-surface-2); border: 1px solid var(--cc-line); padding: 10px 13px;
            border-radius: 12px; font-size: 13px; color: #334155; text-align: left;
            cursor: pointer; transition: all 0.22s var(--cc-ease-out); font-weight: 500;
            display: flex; align-items: center; gap: 8px; letter-spacing: -0.003em;
        }
        .cc-suggested-chip:hover { background: var(--cc-theme); color: #fff; border-color: var(--cc-theme); transform: translateX(2px); box-shadow: 0 4px 12px -4px color-mix(in srgb, ${themeColor} 60%, transparent); }
        .cc-suggested-chip:focus-visible { outline: 2px solid var(--cc-theme); outline-offset: 2px; }

        .cc-bubble-container { display: flex; flex-direction: column; width: 100%; animation: ccFadeIn 0.35s var(--cc-ease-out) forwards; }
        @keyframes ccFadeIn { from { opacity: 0; transform: translateY(10px) scale(0.985); } to { opacity: 1; transform: translateY(0) scale(1); } }

        .cc-bubble {
            max-width: 84%; padding: 11px 15px; border-radius: 17px;
            font-size: 14.5px; line-height: 1.55; word-break: break-word; letter-spacing: -0.003em;
        }
        .cc-bubble p { margin: 0 0 7px 0; }
        .cc-bubble p:last-child { margin-bottom: 0; }
        .cc-bubble strong { font-weight: 650; }
        .cc-bubble ul, .cc-bubble ol { margin: 6px 0; padding-left: 19px; }
        .cc-bubble code { background: rgba(0,0,0,0.06); padding: 2px 5px; border-radius: 5px; font-family: ui-monospace, monospace; font-size: 12.5px; }
        .cc-user .cc-bubble code { background: rgba(255,255,255,0.2); }

        .cc-user { align-items: flex-end; }
        .cc-user .cc-bubble {
            background: var(--cc-theme); background-image: linear-gradient(160deg, color-mix(in srgb, ${themeColor} 100%, white 10%), var(--cc-theme-deep));
            color: #fff; border-bottom-right-radius: 5px;
            box-shadow: 0 6px 16px -4px color-mix(in srgb, ${themeColor} 45%, transparent);
        }
        .cc-ai { align-items: flex-start; }
        .cc-ai .cc-bubble {
            background: var(--cc-surface); color: var(--cc-ink); border-bottom-left-radius: 5px;
            border: 1px solid var(--cc-line); box-shadow: 0 3px 10px -4px rgba(15,23,42,0.06);
        }
        .cc-meta { font-size: 10.5px; color: var(--cc-ink-faint); margin-top: 5px; padding: 0 4px; font-weight: 500; }

        .cc-footer {
            padding: 14px 16px calc(14px + env(safe-area-inset-bottom, 0px)); background: var(--cc-surface);
            border-top: 1px solid var(--cc-line); display: flex; gap: 10px; align-items: flex-end; flex-shrink: 0;
        }
        .cc-input-wrapper {
            flex: 1; position: relative; display: flex; align-items: center;
            background: var(--cc-surface-2); border: 1.5px solid var(--cc-line);
            border-radius: 18px; transition: all 0.25s var(--cc-ease-out);
        }
        .cc-input-wrapper:focus-within { border-color: var(--cc-theme); background: var(--cc-surface); box-shadow: 0 0 0 4px var(--cc-theme-softer); }
        .cc-input {
            width: 100%; background: transparent; border: none; outline: none;
            color: var(--cc-ink); font-family: inherit; resize: none; max-height: 108px;
            padding: ${typebarSize === 'large' ? '13px 44px 13px 15px' : '11px 44px 11px 15px'};
            font-size: 14.5px; line-height: 1.4; letter-spacing: -0.003em;
        }
        .cc-input::placeholder { color: var(--cc-ink-faint); }

        .cc-send-btn {
            background: var(--cc-theme); background-image: linear-gradient(160deg, color-mix(in srgb, ${themeColor} 100%, white 12%), var(--cc-theme-deep));
            border: none; color: #fff; cursor: pointer; display: flex; align-items: center; justify-content: center;
            padding: ${sendButtonStyle === 'pill' ? '0 20px' : '0'};
            width: ${sendButtonStyle === 'pill' ? 'auto' : '44px'};
            height: 44px; border-radius: ${sendButtonStyle === 'pill' ? '22px' : '15px'};
            transition: all 0.3s var(--cc-ease-spring); flex-shrink: 0;
            box-shadow: 0 5px 14px -3px color-mix(in srgb, ${themeColor} 50%, transparent);
            font-weight: 600; font-size: 13.5px; letter-spacing: -0.003em;
        }
        .cc-send-btn svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; transition: transform 0.25s var(--cc-ease-out); }
        .cc-send-btn:hover:not(:disabled) { transform: scale(1.05) translateY(-1px); box-shadow: 0 8px 18px -3px color-mix(in srgb, ${themeColor} 60%, transparent); }
        .cc-send-btn:hover:not(:disabled) svg { transform: translateX(1px); }
        .cc-send-btn:active:not(:disabled) { transform: scale(0.94); }
        .cc-send-btn:focus-visible { outline: 2px solid var(--cc-theme); outline-offset: 2px; }
        .cc-send-btn:disabled { opacity: 0.32; cursor: not-allowed; transform: none; box-shadow: none; }

        .cc-mic-btn {
            position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
            background: none; border: none; color: var(--cc-ink-faint);
            cursor: pointer; padding: 6px; display: ${voiceEnabled ? 'flex' : 'none'};
            align-items: center; justify-content: center; border-radius: 50%; transition: all 0.2s var(--cc-ease-out);
        }
        .cc-mic-btn:hover { color: var(--cc-ink); background-color: var(--cc-line); }
        .cc-mic-btn:focus-visible { outline: 2px solid var(--cc-theme); outline-offset: 1px; }
        .cc-mic-btn svg { width: 19px; height: 19px; fill: none; stroke: currentColor; stroke-width: 2; }
        .cc-mic-btn.recording { color: #ef4444; background-color: #fef2f2; animation: ccPulse 1.3s ease-in-out infinite; }
        @keyframes ccPulse { 0%,100% { transform: translateY(-50%) scale(1); } 50% { transform: translateY(-50%) scale(1.14); } }

        .cc-typing {
            display: none; align-self: flex-start; background: var(--cc-surface); border: 1px solid var(--cc-line);
            padding: 13px 17px; border-radius: 17px; border-bottom-left-radius: 5px;
            gap: 5px; align-items: center; box-shadow: 0 3px 10px -4px rgba(15,23,42,0.06);
        }
        .cc-typing.visible { display: flex; animation: ccFadeIn 0.25s var(--cc-ease-out); }
        .cc-dot { width: 6.5px; height: 6.5px; border-radius: 50%; background: var(--cc-ink-faint); animation: ccBounce 1.3s ease-in-out infinite; }
        .cc-dot:nth-child(2) { animation-delay: 0.15s; }
        .cc-dot:nth-child(3) { animation-delay: 0.3s; }
        @keyframes ccBounce { 0%,80%,100% { transform: translateY(0); opacity: 0.5; } 40% { transform: translateY(-5px); opacity: 1; } }

        .cc-brand-footer { text-align: center; font-size: 10.5px; color: var(--cc-ink-faint); padding: 9px 0 12px; background: var(--cc-surface); font-weight: 500; letter-spacing: -0.003em; }
        .cc-brand-footer a { color: var(--cc-ink-soft); text-decoration: none; font-weight: 700; }
        .cc-brand-footer a:hover { color: var(--cc-theme); }

        @media (max-width: 480px) {
            #cc-widget-window {
                width: 100% !important; height: 100% !important;
                bottom: 0 !important; right: 0 !important; left: 0 !important; top: 0 !important;
                border-radius: 0 !important; transform: none !important;
                padding-bottom: env(safe-area-inset-bottom, 0px);
            }
            #cc-widget-bubble { display: flex; }
            #cc-widget-window.cc-open { transform: none; }
            .cc-header { padding-top: calc(20px + env(safe-area-inset-top, 0px)); }
        }
    `;
    document.head.appendChild(style);

    // ── Build Interactive Floating Bubble ────────────────────────────────────
    const bubble = document.createElement('div');
    bubble.id = 'cc-widget-bubble';
    bubble.setAttribute('role', 'button');
    bubble.setAttribute('aria-label', 'Open chat');
    bubble.tabIndex = 0;
    if (config.logoBase64) {
        bubble.style.backgroundImage = `url('${config.logoBase64}')`;
    } else {
        bubble.innerHTML = `<svg class="cc-icon-chat" viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"/></svg>`;
    }
    const unreadBadge = document.createElement('div');
    unreadBadge.className = 'cc-unread-badge';
    bubble.appendChild(unreadBadge);
    document.body.appendChild(bubble);

    // ── Build Main Window Framework ──────────────────────────────────────────
    const win = document.createElement('div');
    win.id = 'cc-widget-window';
    win.className = 'cc-closed';
    win.setAttribute('role', 'dialog');
    win.setAttribute('aria-label', `${config.name} chat window`);

    // Header Element
    const header = document.createElement('div');
    header.className = 'cc-header';

    const aura = document.createElement('div');
    aura.className = 'cc-header-aura';
    header.appendChild(aura);

    const headerRow = document.createElement('div');
    headerRow.className = 'cc-header-row';
    const headerLeft = document.createElement('div');
    headerLeft.className = 'cc-header-left';

    const avatarContainer = document.createElement('div');
    avatarContainer.className = 'cc-avatar-container';
    const avatar = document.createElement('div');
    avatar.className = 'cc-avatar';
    if (config.logoBase64) {
        avatar.style.backgroundImage = `url('${config.logoBase64}')`;
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

    headerRow.appendChild(headerLeft);
    headerRow.appendChild(closeBtn);
    header.appendChild(headerRow);
    win.appendChild(header);

    // Chat Scroller Compartment
    const chatBox = document.createElement('div');
    chatBox.className = 'cc-chatbox';
    chatBox.id = 'ccChatBox';
    chatBox.setAttribute('aria-live', 'polite');
    win.appendChild(chatBox);

    // Dynamic Context Native Onboarding Card
    const welcomeCard = document.createElement('div');
    welcomeCard.className = 'cc-welcome-card';
    welcomeCard.innerHTML = `
        <p>Hello! Welcome to our automated support helper. Choose a quick question below or type your inquiry natively.</p>
        <div class="cc-suggested-grid">
            <div class="cc-suggested-chip" data-msg="What services do you offer?" tabindex="0" role="button">💡 What services do you offer?</div>
            <div class="cc-suggested-chip" data-msg="Speak to human support" tabindex="0" role="button">🧑‍💻 Connect to human agent</div>
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

    const inputEl = document.createElement('textarea');
    inputEl.rows = 1;
    inputEl.className = 'cc-input';
    inputEl.id = 'ccInput';
    inputEl.placeholder = 'Type a message…';
    inputEl.setAttribute('autocomplete', 'off');
    inputEl.setAttribute('aria-label', 'Type a message');

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
    brandFooter.innerHTML = 'Powered by <a href="#" target="_blank" rel="noopener">Comex AI</a>';
    win.appendChild(brandFooter);

    document.body.appendChild(win);

    // ── Autosize the input textarea as the user types ────────────────────────
    function autosizeInput() {
        inputEl.style.height = 'auto';
        inputEl.style.height = Math.min(inputEl.scrollHeight, 108) + 'px';
    }
    inputEl.addEventListener('input', autosizeInput);

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

        if (!isUser && !win.classList.contains('cc-open')) {
            unreadCount += 1;
            unreadBadge.textContent = unreadCount > 9 ? '9+' : String(unreadCount);
            unreadBadge.classList.add('cc-show');
        }
        return container;
    }

    // Initialize Global Interactive Handlers
    function openWidget() {
        win.style.display = 'flex';
        bubble.classList.add('cc-active');
        bubble.setAttribute('aria-label', 'Close chat');
        unreadCount = 0;
        unreadBadge.classList.remove('cc-show');
        setTimeout(() => {
            win.className = 'cc-open';
            inputEl.focus();
        }, 10);
    }

    function closeWidget() {
        win.className = 'cc-closed';
        bubble.classList.remove('cc-active');
        bubble.setAttribute('aria-label', 'Open chat');
        setTimeout(() => { win.style.display = 'none'; }, 300);
    }

    bubble.addEventListener('click', () => {
        if (win.classList.contains('cc-open')) {
            closeWidget();
        } else {
            openWidget();
        }
    });
    bubble.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            bubble.click();
        }
    });

    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeWidget();
    });

    // ── Onboarding Suggestion Setup ──────────────────────────────────────────
    win.querySelectorAll('.cc-suggested-chip').forEach(chip => {
        const trigger = () => {
            inputEl.value = chip.getAttribute('data-msg');
            sendMessage();
            welcomeCard.style.display = 'none';
        };
        chip.addEventListener('click', trigger);
        chip.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); trigger(); } });
    });

    // ── Core Async Transmission Controller ────────────────────────────────────
    async function sendMessage() {
        const text = inputEl.value.trim();
        if (!text || isSending) return;

        isSending = true;
        sendBtn.disabled = true;
        inputEl.value = '';
        autosizeInput();
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
                autosizeInput();
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
