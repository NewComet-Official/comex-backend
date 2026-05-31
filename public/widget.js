(function() {
    // 1. Extract specific configuration attributes from the script tag setup
    const scriptTag = document.currentScript;
    const businessId = scriptTag.getAttribute('data-business-id');
    const position = scriptTag.getAttribute('data-position') || 'bottom-right';
    const customLogo = scriptTag.getAttribute('data-logo'); // Reads custom logo configurations

    if (!businessId) {
        console.error("CometChat AI Error: Missing data-business-id attribute.");
        return;
    }

    // Determine target location rules based on position parameter configuration
    let bubblePositioningStyles = '';
    let windowPositioningStyles = '';

    if (position === 'bottom-right') {
        bubblePositioningStyles = 'bottom: 25px; right: 25px;';
        windowPositioningStyles = 'bottom: 100px; right: 25px;';
    } else if (position === 'bottom-left') {
        bubblePositioningStyles = 'bottom: 25px; left: 25px;';
        windowPositioningStyles = 'bottom: 100px; left: 25px;';
    } else if (position === 'top-right') {
        bubblePositioningStyles = 'top: 25px; right: 25px;';
        windowPositioningStyles = 'top: 100px; right: 25px;';
    } else if (position === 'top-left') {
        bubblePositioningStyles = 'top: 25px; left: 25px;';
        windowPositioningStyles = 'top: 100px; left: 25px;';
    }

    // 2. Inject CSS Styles directly into the host website head section
    const style = document.createElement('style');
    style.innerHTML = `
        #cc-widget-bubble {
            position: fixed; ${bubblePositioningStyles}
            width: 60px; height: 60px; background-color: #000000;
            border-radius: 50%; display: flex; align-items: center; justify-content: center;
            font-size: 26px; cursor: pointer; box-shadow: 0 10px 25px rgba(0,0,0,0.2);
            transition: 0.3s; z-index: 999999; user-select: none; color: white;
            background-size: cover; background-position: center; border: 2px solid #ffffff;
        }
        #cc-widget-bubble:hover { transform: scale(1.05); box-shadow: 0 15px 35px rgba(0,0,0,0.3); }
        
        #cc-widget-window {
            position: fixed; ${windowPositioningStyles}
            width: 360px; height: 500px; background-color: #ffffff;
            border: 1px solid #e5e7eb; border-radius: 16px; display: none;
            flex-direction: column; overflow: hidden; box-shadow: 0 20px 40px rgba(0,0,0,0.15);
            z-index: 999999; font-family: system-ui, sans-serif; color: #111827;
        }
        .cc-header { padding: 20px; background: #f9fafb; border-bottom: 1px solid #e5e7eb; font-weight: 700; font-size: 15px; display: flex; align-items: center; gap: 10px; }
        .cc-chatbox { flex: 1; padding: 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 12px; background: #ffffff; }
        .cc-bubble { max-width: 85%; padding: 12px 16px; border-radius: 14px; font-size: 14px; line-height: 1.4; }
        .cc-user { background: #111827; color: #ffffff; align-self: flex-end; border-bottom-right-radius: 4px; }
        .cc-ai { background: #f3f4f6; color: #111827; align-self: flex-start; border-bottom-left-radius: 4px; border: 1px solid #e5e7eb; }
        .cc-footer { padding: 15px; background: #f9fafb; border-top: 1px solid #e5e7eb; display: flex; gap: 10px; }
        .cc-input { flex: 1; background: #ffffff; border: 1px solid #d1d5db; padding: 10px 14px; border-radius: 8px; color: #111827; outline: none; font-size: 14px; }
        .cc-input:focus { border-color: #111827; }
        .cc-btn { background: #111827; border: none; color: #ffffff; padding: 0 16px; border-radius: 8px; cursor: pointer; font-weight: bold; }
    `;
    document.head.appendChild(style);

    // 3. Create the Floating Action Bubble Element
    const bubble = document.createElement('div');
    bubble.id = 'cc-widget-bubble';
    
    // Check if the HTML snippet contained our custom injected base64 data parameter
    if (customLogo && customLogo !== "null") {
        bubble.style.backgroundImage = `url('${customLogo}')`;
    } else {
        bubble.innerHTML = '💬';
    }
    document.body.appendChild(bubble);

    // 4. Create the Chat Window Overlay Container
    const windowContainer = document.createElement('div');
    windowContainer.id = 'cc-widget-window';
    windowContainer.innerHTML = `
        <div class="cc-header">${businessId.toUpperCase().replace('-', ' ')}</div>
        <div class="cc-chatbox" id="ccChatBox">
            <div class="cc-bubble cc-ai">Hello! How can I assist you today?</div>
        </div>
        <div class="cc-footer">
            <input type="text" class="cc-input" id="ccInputField" placeholder="Type a message...">
            <button class="cc-btn" id="ccSendBtn">➔</button>
        </div>
    `;
    document.body.appendChild(windowContainer);

    // 5. Toggle panel layout viewing states during interactions
    bubble.onclick = () => {
        windowContainer.style.display = windowContainer.style.display === 'flex' ? 'none' : 'flex';
    };

    // 6. Handle Messaging Functionality connecting back to our server backend pipeline
    async function sendMessage() {
        const input = document.getElementById('ccInputField');
        const chatBox = document.getElementById('ccChatBox');
        const question = input.value.trim();

        if (!question) return;

        chatBox.innerHTML += `<div class="cc-bubble cc-user">${question}</div>`;
        input.value = '';
        chatBox.scrollTop = chatBox.scrollHeight;

        try {
        // Change this line:
const response = await fetch('https://comex-backend.vercel.app/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessId, question })
});
            const data = await response.json();
            chatBox.innerHTML += `<div class="cc-bubble cc-ai">${data.answer}</div>`;
            chatBox.scrollTop = chatBox.scrollHeight;
        } catch (error) {
            chatBox.innerHTML += `<div class="cc-bubble cc-ai">Connection interrupted.</div>`;
        }
    }

    // Attach programmatic click and shortcut keystroke listeners
    document.getElementById('ccSendBtn').onclick = sendMessage;
    document.getElementById('ccInputField').onkeypress = (e) => { if (e.key === 'Enter') sendMessage(); };
})();