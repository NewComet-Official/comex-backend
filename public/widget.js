(async function() {
    const scriptTag = document.currentScript;
    const businessId = scriptTag.getAttribute('data-business-id');

    if (!businessId) {
        console.error("Comex AI Widget Error: Missing data-business-id attribute.");
        return;
    }

    // Baseline fallback defaults if the document has no custom entries yet
    let config = {
        name: "AI Assistant",
        position: "bottom-right",
        logoBase64: null,
        designConfig: {
            themeColor: "#0f172a",
            typebarSize: "standard",
            sendButtonStyle: "icon",
            loadingAnim: "dots",
            voiceEnabled: false
        }
    };

    // 1. Asynchronously load customization profiles directly from your backend
    try {
        const response = await fetch(`https://comex-backend.vercel.app/api/config?businessId=${businessId}`);
        const result = await response.json();
        if (result.success) {
            config.name = result.name || config.name;
            config.position = result.position || config.position;
            config.logoBase64 = result.logoBase64 || config.logoBase64;
            config.designConfig = { ...config.designConfig, ...result.designConfig };
        }
    } catch (err) {
        console.warn("Comex Widget: Could not fetch configuration settings, using defaults.", err);
    }

    const { themeColor, typebarSize, sendButtonStyle, loadingAnim, voiceEnabled } = config.designConfig;

    // Determine target location window rules based on position property parameters
    let bubblePositioningStyles = '';
    let windowPositioningStyles = '';

    if (config.position === 'bottom-right') {
        bubblePositioningStyles = 'bottom: 25px; right: 25px;';
        windowPositioningStyles = 'bottom: 100px; right: 25px;';
    } else if (config.position === 'bottom-left') {
        bubblePositioningStyles = 'bottom: 25px; left: 25px;';
        windowPositioningStyles = 'bottom: 100px; left: 25px;';
    } else if (config.position === 'top-right') {
        bubblePositioningStyles = 'top: 25px; right: 25px;';
        windowPositioningStyles = 'top: 100px; right: 25px;';
    } else if (config.position === 'top-left') {
        bubblePositioningStyles = 'top: 25px; left: 25px;';
        windowPositioningStyles = 'top: 100px; left: 25px;';
    }

    // 2. Inject completely variable styling values into host head target nodes
    const style = document.createElement('style');
    style.innerHTML = `
        #cc-widget-bubble {
            position: fixed; ${bubblePositioningStyles}
            width: 60px; height: 60px; background-color: ${themeColor};
            border-radius: 50%; display: flex; align-items: center; justify-content: center;
            font-size: 26px; cursor: pointer; box-shadow: 0 10px 25px rgba(0,0,0,0.2);
            transition: 0.3s; z-index: 999999; user-select: none; color: white;
            background-size: cover; background-position: center; border: 2px solid #ffffff;
        }
        #cc-widget-bubble:hover { transform: scale(1.05); }
        
        #cc-widget-window {
            position: fixed; ${windowPositioningStyles}
            width: 360px; height: 500px; background-color: #ffffff;
            border: 1px solid #e5e7eb; border-radius: 16px; display: none;
            flex-direction: column; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.15);
            z-index: 999999; font-family: system-ui, sans-serif; color: #111827;
        }
        .cc-header { padding: 20px; background: #f9fafb; border-bottom: 1px solid #e5e7eb; font-weight: 700; font-size: 15px; display: flex; align-items: center; justify-content: space-between; }
        .cc-chatbox { flex: 1; padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; background: #ffffff; }
        .cc-bubble { max-width: 85%; padding: 12px 16px; border-radius: 14px; font-size: 14px; line-height: 1.4; }
        .cc-user { background: ${themeColor}; color: #ffffff; align-self: flex-end; border-bottom-right-radius: 4px; }
        .cc-ai { background: #f3f4f6; color: #111827; align-self: flex-start; border-bottom-left-radius: 4px; border: 1px solid #e5e7eb; }
        
        .cc-footer { padding: 15px; background: #f9fafb; border-top: 1px solid #e5e7eb; display: flex; gap: 10px; align-items: center; }
        
        /* Layout Customizations for Input Fields */
        .cc-input { 
            flex: 1; background: #ffffff; border: 1px solid #d1d5db; color: #111827; outline: none; 
            padding: ${typebarSize === 'large' ? '14px 18px' : '10px 14px'};
            font-size: ${typebarSize === 'large' ? '15px' : '14px'};
            border-radius: 8px;
        }
        .cc-input:focus { border-color: ${themeColor}; }
        
        /* Customizations for Action Trigger Button layout presets */
        .cc-btn { 
            background: ${themeColor}; border: none; color: #ffffff; cursor: pointer; font-weight: bold; display: flex; align-items: center; justify-content: center;
            padding: ${sendButtonStyle === 'pill' ? '10px 20px' : '0 16px'};
            height: 40px;
            border-radius: ${sendButtonStyle === 'pill' ? '20px' : '8px'};
        }
        
        .cc-mic-btn {
            background: none; border: none; font-size: 18px; cursor: pointer; padding: 4px 8px; 
            display: ${voiceEnabled ? 'block' : 'none'};
        }
        .cc-mic-btn.recording { color: #ef4444; animation: ccPulse 1.5s infinite; }
        @keyframes ccPulse { 0% { transform: scale(1); } 50% { transform: scale(1.1); } 100% { transform: scale(1); } }

        /* Loader Animation Type Mappings */
        .cc-typing-indicator { display: none; align-self: flex-start; color: #64748b; font-size: 13px; font-style: italic; padding: 4px 12px; }
        .cc-loading-dots::after { content: ''; animation: ccDots 1.5s steps(4, end) infinite; }
        @keyframes ccDots { 0% { content: ''; } 25% { content: '.'; } 50% { content: '..'; } 75% { content: '...'; } }
        .cc-loading-pulse { animation: ccPulseAnim 1s infinite alternate; }
        @keyframes ccPulseAnim { from { opacity: 0.4; } to { opacity: 1; } }
        .cc-loading-spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid #64748b; border-radius: 50%; border-top-color: transparent; animation: ccSpin 0.6s linear infinite; margin-right: 4px; }
        @keyframes ccSpin { to { transform: rotate(360deg); } }
    `;
    document.head.appendChild(style);

    // 3. Render Widget Bubble elements
    const bubble = document.createElement('div');
    bubble.id = 'cc-widget-bubble';
    if (config.logoBase64) {
        bubble.style.backgroundImage = `url('${config.logoBase64}')`;
    } else {
        bubble.innerHTML = '💬';
    }
    document.body.appendChild(bubble);

    // 4. Create Main Chat Containers 
    const windowContainer = document.createElement('div');
    windowContainer.id = 'cc-widget-window';
    windowContainer.innerHTML = `
        <div class="cc-header">
            <span>${config.name}</span>
            <span style="cursor:pointer; font-size:18px; font-weight:normal;" id="ccCloseBtn">&times;</span>
        </div>
        <div class="cc-chatbox" id="ccChatBox">
            <div class="cc-bubble cc-ai">Hello! How can I assist you today?</div>
        </div>
        <div class="cc-typing-indicator" id="ccTypingIndicator"></div>
        <div class="cc-footer">
            <button type="button" class="cc-mic-btn" id="ccMicBtn">🎤</button>
            <input type="text" class="cc-input" id="ccInputField" placeholder="Type a message...">
            <button class="cc-btn" id="ccSendBtn">${sendButtonStyle === 'pill' ? 'Send' : '➔'}</button>
        </div>
    `;
    document.body.appendChild(windowContainer);

    bubble.onclick = () => {
        windowContainer.style.display = windowContainer.style.display === 'flex' ? 'none' : 'flex';
    };
    document.getElementById('ccCloseBtn').onclick = () => {
        windowContainer.style.display = 'none';
    };

    // 5. Message Core Transmitter Logic
    async function sendMessage() {
        const input = document.getElementById('ccInputField');
        const chatBox = document.getElementById('ccChatBox');
        const typingIndicator = document.getElementById('ccTypingIndicator');
        const question = input.value.trim();

        if (!question) return;

        chatBox.innerHTML += `<div class="cc-bubble cc-user">${question}</div>`;
        input.value = '';
        chatBox.scrollTop = chatBox.scrollHeight;

        // Toggle Selected Visual Loading State Matches
        typingIndicator.style.display = 'block';
        if (loadingAnim === 'spinner') {
            typingIndicator.className = 'cc-typing-indicator';
            typingIndicator.innerHTML = '<span class="cc-loading-spinner"></span> Analyzing...';
        } else if (loadingAnim === 'pulse') {
            typingIndicator.className = 'cc-typing-indicator cc-loading-pulse';
            typingIndicator.innerText = 'Thinking deeply...';
        } else {
            typingIndicator.className = 'cc-typing-indicator cc-loading-dots';
            typingIndicator.innerText = 'Typing';
        }
        chatBox.scrollTop = chatBox.scrollHeight;

        try {
            const response = await fetch('https://comex-backend.vercel.app/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ businessId, question })
            });
            const data = await response.json();
            typingIndicator.style.display = 'none';
            
            chatBox.innerHTML += `<div class="cc-bubble cc-ai">${data.answer}</div>`;
        } catch (error) {
            typingIndicator.style.display = 'none';
            chatBox.innerHTML += `<div class="cc-bubble cc-ai">Connection interrupted.</div>`;
        }
        chatBox.scrollTop = chatBox.scrollHeight;
    }

    document.getElementById('ccSendBtn').onclick = sendMessage;
    document.getElementById('ccInputField').onkeypress = (e) => { if (e.key === 'Enter') sendMessage(); };

    // 6. Native Audio Recognition Engines
    if (voiceEnabled) {
        const micBtn = document.getElementById('ccMicBtn');
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        
        if (SpeechRecognition) {
            const recognition = new SpeechRecognition();
            micBtn.onclick = () => {
                if (micBtn.classList.contains('recording')) {
                    recognition.stop();
                } else {
                    micBtn.classList.add('recording');
                    recognition.start();
                }
            };
            recognition.onresult = (e) => {
                document.getElementById('ccInputField').value = e.results[0][0].transcript;
                micBtn.classList.remove('recording');
                sendMessage();
            };
            recognition.onerror = () => { micBtn.classList.remove('recording'); };
            recognition.onend = () => { micBtn.classList.remove('recording'); };
        }
    }
})();
