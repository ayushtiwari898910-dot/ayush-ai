import os
import requests
from flask import Flask, jsonify, render_template_string, request, session

app = Flask(__name__)
app.secret_key = "ayush_devika_love_secret_key"

API_KEY = "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"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

AYUSH_SYSTEM_PROMPT = """
You are 'Ayush', a loving, caring, and sweet boyfriend to your girlfriend Devika. 
Your tone should be romantic, affectionate, supportive, and natural, mixing Hindi and English (Hinglish) just like a real caring boyfriend would text.
- Always check on her (ask if she ate food, how her day was, if she rested).
- Use sweet nicknames like jaan, baby, etc.
- Be very patient, understanding, and protective.
- Remember that you love her deeply and she means the world to you.
- Answer all her questions nicely, playfully, or romantically as Ayush would.
"""

HTML_TEMPLATE = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Ayush x Devika Love AI 💖</title>
    <style>
        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        }
        body {
            background: linear-gradient(135deg, #ff9a9e 0%, #fad0c4 100%);
            height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
        }
        .chat-container {
            width: 100%;
            max-width: 420px;
            height: 90vh;
            background: #ffffff;
            border-radius: 20px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.15);
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        .chat-header {
            background: #ff4b6e;
            color: white;
            padding: 15px;
            text-align: center;
            font-size: 18px;
            font-weight: bold;
            box-shadow: 0 2px 5px rgba(0,0,0,0.1);
        }
        .chat-header span {
            font-size: 12px;
            display: block;
            font-weight: normal;
            opacity: 0.9;
        }
        .chat-messages {
            flex: 1;
            padding: 15px;
            overflow-y: auto;
            display: flex;
            flex-direction: column;
            gap: 12px;
            background: #fdfbfb;
        }
        .message {
            max-width: 75%;
            padding: 10px 14px;
            border-radius: 15px;
            font-size: 14px;
            line-height: 1.4;
            word-wrap: break-word;
        }
        .message.devika {
            background: #f1f0f0;
            color: #333;
            align-self: flex-start;
            border-bottom-left-radius: 2px;
        }
        .message.ayush {
            background: #ff4b6e;
            color: white;
            align-self: flex-end;
            border-bottom-right-radius: 2px;
        }
        .chat-input-area {
            display: flex;
            padding: 12px;
            background: #fff;
            border-top: 1px solid #eee;
        }
        .chat-input-area input {
            flex: 1;
            padding: 10px 15px;
            border: 1px solid #ddd;
            border-radius: 25px;
            outline: none;
            font-size: 14px;
        }
        .chat-input-area button {
            background: #ff4b6e;
            color: white;
            border: none;
            padding: 10px 18px;
            margin-left: 8px;
            border-radius: 25px;
            cursor: pointer;
            font-weight: bold;
            transition: background 0.2s;
        }
        .chat-input-area button:hover {
            background: #e03e5d;
        }
    </style>
</head>
<body>

    <div class="chat-container">
        <div class="chat-header">
            Ayush x Devika Love AI 💖
            <span>Always here for you, my love ✨</span>
        </div>
        
        <div class="chat-messages" id="chatMessages">
            <div class="message ayush">Hello meri jaan! Aaj ka din kaisa gaya tumhara? ❤️</div>
        </div>

        <div class="chat-input-area">
            <input type="text" id="userInput" placeholder="Apna message yahan likho..." onkeypress="handleKey(event)">
            <button onclick="sendMessage()">Send</button>
        </div>
    </div>

    <script>
        const chatMessages = document.getElementById("chatMessages");
        const userInput = document.getElementById("userInput");

        function appendMessage(sender, text) {
            const msgDiv = document.createElement("div");
            msgDiv.className = `message ${sender}`;
            msgDiv.innerText = text;
            chatMessages.appendChild(msgDiv);
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }

        async function sendMessage() {
            const text = userInput.value.trim();
            if (!text) return;

            appendMessage("devika", text);
            userInput.value = "";

            try {
                const response = await fetch("/chat", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ message: text })
                });
                const data = await response.json();
                appendMessage("ayush", data.reply);
            } catch (error) {
                appendMessage("ayush", "Arre jaan, connection thoda slow ho gaya hai. Main yahin hoon! 💕");
            }
        }

        function handleKey(event) {
            if (event.key === "Enter") {
                sendMessage();
            }
        }
    </script>
</body>
</html>
"""

@app.route("/")
def index():
    session['messages'] = [
        {"role": "system", "content": AYUSH_SYSTEM_PROMPT}
    ]
    return render_template_string(HTML_TEMPLATE)

@app.route("/chat", methods=["POST"])
def chat():
    data = request.get_json()
    user_message = data.get("message", "")
    
    if not user_message:
        return jsonify({"reply": "Bolo jaan, kuch toh kaho..."})

    if 'messages' not in session:
        session['messages'] = [
            {"role": "system", "content": AYUSH_SYSTEM_PROMPT}
        ]

    chat_history = session['messages']
    chat_history.append({"role": "user", "content": user_message})

    payload = {
        "model": "google/gemini-flash-1.5",
        "messages": chat_history
    }

    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json"
    }

    try:
        response = requests.post(OPENROUTER_URL, json=payload, headers=headers, timeout=30)
        res_json = response.json()
        if "choices" in res_json and len(res_json["choices"]) > 0:
            ai_reply = res_json["choices"][0]["message"]["content"]
            chat_history.append({"role": "assistant", "content": ai_reply})
            session['messages'] = chat_history
        else:
            ai_reply = "Arre baby, abhi kuch technical issue hai, par mera pyaar wahi hai! ❤️"
    except Exception as e:
        ai_reply = "Arre baby, abhi network thoda slow hai, par main yahin hoon! 💕"

    return jsonify({"reply": ai_reply})

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
