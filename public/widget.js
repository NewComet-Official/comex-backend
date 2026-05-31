(function() {
    if (window.ComexInitialized) return;
    window.ComexInitialized = true;

    const scriptTag = document.currentScript;
    const businessId = scriptTag.getAttribute('data-business-id');

    const style = document.createElement('style');
    style.innerHTML = `
        #comex-chat-trigger {
            position: fixed; bottom: 20px; right: 20px;
            width: 60px; height: 60px; background: #0f172a;
            border-radius: 50%; color: white; display: flex;
            align-items: center; justify-content: center;
            cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            font-size: 24px; z-index: 999999; transition: transform 0.2s;
        }
        #comex-chat-trigger:hover { transform: scale(1.05); }
        #comex-chat-window {
            position: fixed; bottom: 90px; right: 20px;
            width: 350px; height: 500px; background: white;
            border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.2);
            display: none; flex-direction: column; overflow: hidden;
            z-index: 999999; border: 1px solid #eaeaea; font-family: system-ui, sans-serif;
        }
        .comex-header { background: #0f172a; color: white; padding: 15px; font-weight: bold; }
        .comex-messages { flex: 1; padding: 15px; overflow-y: auto; background: #f9f9f9; }
        .comex-input-area { display: flex; border-top: 1px solid #eaeaea; }
        .comex-input { flex: 1; border: none; padding: 12px; outline: none; }
        .comex-btn { background: #0f172a; color: white; border: none; padding: 0 15px; cursor: pointer; }
    `;
    document.head.appendChild(style);

    const trigger = document.createElement('div');
    trigger.id = 'comex-chat-trigger';
    trigger.innerHTML = '💬';

    const windowDiv = document.createElement('div');
    windowDiv.id = 'comex-chat-window';
    windowDiv.innerHTML = `
        <div class="comex-header">Comex AI Assistant</div>
        <div class="comex-messages" id="comex-msg-box">
            <div style="margin-bottom: 10px; color: #555;">Hello! How can I help you today?</div>
        </div>
        <div class="comex-input-area">
            <input type="text" class="comex-input" id="comex-input-field" placeholder="Ask a question...">
            <button class="comex-btn" id="comex-send-btn">Send</button>
        </div>
    `;

    document.body.appendChild(trigger);
    document.body.appendChild(windowDiv);

    trigger.addEventListener('click', () => {
        windowDiv.style.display = windowDiv.style.display === 'flex' ? 'none' : 'flex';
    });

    const sendBtn = document.getElementById('comex-send-btn');
    const inputField = document.getElementById('comex-input-field');
    const msgBox = document.getElementById('comex-msg-box');

    sendBtn.addEventListener('click', async () => {
        const text = inputField.value.trim();
        if (!text) return;

        const userDiv = document.createElement('div');
        userDiv.style.cssText = "margin-bottom: 10px; text-align: right; color: #3b82f6; font-weight: 500;";
        userDiv.innerText = text;
        msgBox.appendChild(userDiv);
        inputField.value = '';
    });
})();