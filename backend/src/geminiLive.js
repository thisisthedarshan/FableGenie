const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ 
  vertexai: {
    project: process.env.GOOGLE_CLOUD_PROJECT,
    location: process.env.VERTEX_AI_LOCATION
  }
});
const MODEL_NAME = 'gemini-2.5-flash-preview-native-audio-dialog';

class GeminiLiveSession {
  constructor(initialPrompt) {
    this.systemPrompt = initialPrompt;
    this.session = null;
    this.onOutputCallback = null;
  }

  async initialize() {
    console.log('[GeminiLive] Initializing session...');
    this.session = await ai.chats.create({
        model: MODEL_NAME,
        config: {
            systemInstruction: this.systemPrompt,
        }
    });
  }

  async swapSystemPrompt(newPrompt) {
    console.log('[GeminiLive] Swapping system prompt...');
    this.systemPrompt = newPrompt;
    // For experimental SDKs, swapping the prompt might require closing and recreating the session,
    // or passing it via a config update. We'll simply recreate the session for simplicity and reliability.
    this.session = await ai.chats.create({
        model: MODEL_NAME,
        config: {
            systemInstruction: this.systemPrompt,
        }
    });
  }

  onOutput(callback) {
    this.onOutputCallback = callback;
  }

  // Sends audio buffers from WebRTC to Gemini
  async sendAudio(base64AudioChunk) {
    if (!this.session) return;
    try {
        const response = await this.session.sendMessage({
            inlineData: {
                mimeType: 'audio/pcm;rate=16000', 
                data: base64AudioChunk
            }
        });
        
        // For Live models, the text payload is often returned immediately
        if (response.text && this.onOutputCallback) {
            this.onOutputCallback(response.text);
        }
    } catch(e) {
        console.error('[GeminiLive] Audio streaming error:', e);
    }
  }

  // Sends video frames from WebRTC to Gemini
  async sendVideo(base64VideoFrame) {
    if (!this.session) return;
    try {
        const response = await this.session.sendMessage({
            inlineData: {
                mimeType: 'image/jpeg',
                data: base64VideoFrame
            }
        });

        if (response.text && this.onOutputCallback) {
            this.onOutputCallback(response.text);
        }
    } catch(e) {
        console.error('[GeminiLive] Video streaming error:', e);
    }
  }

  close() {
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
