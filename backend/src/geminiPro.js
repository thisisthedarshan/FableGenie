const { VertexAI } = require('@google-cloud/vertexai');

let vertexAI = null;
function getVertexAI() {
  if (!vertexAI) {
    vertexAI = new VertexAI({
      project: process.env.GOOGLE_CLOUD_PROJECT,
      location: process.env.VERTEX_AI_LOCATION,
    });
  }
  return vertexAI;
}

const MODEL_NAME = 'gemini-2.5-pro'; // User requested gemini-2.5-pro

class GeminiProSession {
  constructor(systemPrompt) {
    this.systemPrompt = systemPrompt;
    const generativeModel = getVertexAI().getGenerativeModel({
      model: MODEL_NAME,
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: {
        temperature: 0.7,
      }
    });
    // Start chat session with no initial history
    this.chatSession = generativeModel.startChat({});
    this.onChunkCallback = null;
  }

  onChunk(callback) {
    this.onChunkCallback = callback;
  }

  async generateTurn(message) {
    console.log(`[GeminiPro] Generating turn for message: ${message}`);
    try {
      const result = await this.chatSession.sendMessageStream(message);
      
      // FIX: In Vertex AI SDK, sendMessageStream returns a response where
      // the actual stream is in the 'stream' property.
      for await (const chunk of result.stream) {
        // Extract text from the candidate parts
        const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text && this.onChunkCallback) {
          this.onChunkCallback(text);
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
