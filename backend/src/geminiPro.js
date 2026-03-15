const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL_NAME = 'gemini-2.5-pro-preview-06-05';

class GeminiProSession {
  constructor(systemPrompt) {
    this.systemPrompt = systemPrompt;
    this.chatSession = ai.chats.create({
      model: MODEL_NAME,
      config: {
        systemInstruction: systemPrompt,
        temperature: 0.7, // Add some creativity to the fable
      }
    });
    this.onChunkCallback = null;
  }

  onChunk(callback) {
    this.onChunkCallback = callback;
  }

  async generateTurn(message) {
    console.log(`[GeminiPro] Generating turn for message: ${message}`);
    try {
      const stream = await this.chatSession.sendMessageStream(message);
      
      for await (const chunk of stream) {
        if (chunk.text && this.onChunkCallback) {
          this.onChunkCallback(chunk.text);
        }
      }
    } catch (e) {
      console.error('[GeminiPro] Streaming error:', e);
    }
  }

  close() {
    // No explicit close needed for basic generateContent stream,
    // but useful if we manage memory
    this.onChunkCallback = null;
  }
}

async function create(systemPrompt) {
  return new GeminiProSession(systemPrompt);
}

module.exports = { create };
