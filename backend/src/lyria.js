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

const MODEL_NAME = 'lyria-realtime-exp';

class LyriaStream {
  constructor(socket) {
    this.socket = socket;
    this.session = null;
    this.isOpen = false;
  }

  async open() {
    console.log('[Lyria] Opening persistent ambient stream...');
    try {
      const generativeModel = getVertexAI().getGenerativeModel({ model: MODEL_NAME });
      this.session = generativeModel.startChat({});
      this.isOpen = true;
      // Start streaming loop here if the SDK requires pulling
    } catch (e) {
      console.error('[Lyria] Failed to open stream:', e);
      this.isOpen = false; // Fallback will trigger on setMood
    }
  }

  async setMood(mood) {
    if (!this.isOpen || !this.session) {
       console.log(`[Lyria fallback] Mocking ambient change to: ${mood}`);
       return; 
    }
    
    console.log(`[Lyria] Steering continuous stream to mood: ${mood}`);
    try {
       const response = await this.session.sendMessage([{text: `Ambient, cinematic, ${mood} background loop, entirely instrumental`}]);
       
       if (response && response.response && response.response.candidates && response.response.candidates[0].content.parts) {
            const parts = response.response.candidates[0].content.parts;
            // Scan for raw PCM audio chunks returned inline
            const audioPart = parts.find(p => p.inlineData && p.inlineData.mimeType.includes('audio/pcm'));
            if (audioPart) {
                // Pipe to client
                this.socket.send(JSON.stringify({
                    type: 'lyria_pcm',
                    data: audioPart.inlineData.data
                }));
            }
        }
    } catch(e) {
       console.error('[Lyria] Streaming error:', e);
    }
  }

  close() {
    console.log('[Lyria] Closing ambient stream.');
    if (this.session) {
      // this.session.close(); if SDK supports it
      this.session = null;
    }
    this.isOpen = false;
  }
}

module.exports = { LyriaStream };
