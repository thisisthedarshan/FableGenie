const { GoogleGenAI } = require('@google/genai');

let ai = null;
function getAi() {
  if (!ai) {
    ai = new GoogleGenAI({ 
      vertexai: true,
      project: process.env.GOOGLE_CLOUD_PROJECT,
      location: process.env.VERTEX_AI_LOCATION
    });
  }
  return ai;
}
const MODEL_NAME = 'gemini-live-2.5-flash-native-audio';

class GeminiLiveSession {
  constructor(initialPrompt) {
    this.systemPrompt = initialPrompt;
    this.session = null;
    this.onOutputCallback = null;
    this._listenLoop = null;
  }

  async initialize() {
    console.log('[GeminiLive] Initializing live session...');
    this.session = await getAi().live.connect({
        model: MODEL_NAME,
        config: {
            systemInstruction: { parts: [{ text: this.systemPrompt }] },
            generationConfig: {
                responseModalities: ["TEXT"]
            }
        },
        callbacks: {
            onmessage: (message) => {
                if (message.serverContent && message.serverContent.modelTurn) {
                    const parts = message.serverContent.modelTurn.parts;
                    if (parts && parts.length > 0) {
                        const text = parts.map(p => p.text).filter(Boolean).join('');
                        if (text && this.onOutputCallback) {
                            this.onOutputCallback(text);
                        }
                    }
                }
            },
            onerror: (err) => console.error('[GeminiLive] Websocket error', err),
            onclose: () => console.log('[GeminiLive] Websocket closed')
        }
    });
  }

  async swapSystemPrompt(newPrompt) {
    console.log('[GeminiLive] Swapping system prompt...');
    this.systemPrompt = newPrompt;
    // For experimental SDKs, Live models usually don't support hot-swapping config mid-stream easily.
    // We recreate the session.
    this.close();
    await this.initialize();
  }

  onOutput(callback) {
    this.onOutputCallback = callback;
  }

  async sendText(text) {
    if (!this.session) return;
    try {
        await this.session.sendClientContent({
            turns: [{
                role: "user",
                parts: [{ text: text }]
            }],
            turnComplete: true
        });
    } catch(e) {
        console.error('[GeminiLive] Text streaming error:', e);
    }
  }

  // Sends audio buffers from WebRTC to Gemini
  async sendAudio(base64AudioChunk) {
    if (!this.session) return;
    try {
        await this.session.sendRealtimeInput([{
            mimeType: 'audio/pcm;rate=16000', 
            data: base64AudioChunk
        }]);
    } catch(e) {
        console.error('[GeminiLive] Audio streaming error:', e);
    }
  }

  // Sends video frames from WebRTC to Gemini
  async sendVideo(base64VideoFrame) {
    if (!this.session) return;
    try {
        await this.session.sendRealtimeInput([{
            mimeType: 'image/jpeg',
            data: base64VideoFrame
        }]);
    } catch(e) {
        console.error('[GeminiLive] Video streaming error:', e);
    }
  }

  close() {
    if (this.session) {
      try {
        // AI Live sessions in @google/genai aren't typically strictly closer functions, 
        // they just drop the websocket reference if no explicit close exists.
        if (typeof this.session.close === 'function') {
           this.session.close();
        }
      } catch(e) {}
    }
    this.session = null;
    this.onOutputCallback = null;
    console.log('[GeminiLive] Session closed.');
  }
}

async function create(initialPrompt) {
  const session = new GeminiLiveSession(initialPrompt);
  await session.initialize();
  return session;
}

module.exports = { create };
