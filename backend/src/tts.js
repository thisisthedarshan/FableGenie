const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL_NAME = 'gemini-2.5-flash-preview-tts';

class TTSPipeline {
  constructor(socket) {
    this.socket = socket;
    this.queue = [];
    this.isSynthesizing = false;
    this.currentPlayIndex = 0;
    this.nextChunkIndex = 0;
    this.lookahead = 2; 
  }

  async enqueue(text, phase) {
    this.queue.push({
      text,
      phase,
      chunkIndex: this.nextChunkIndex++,
      audioBase64: null,
      status: 'pending' // pending, synthesizing, ready, played
    });
    this.processQueue();
  }

  advance(playedChunkIndex) {
    this.currentPlayIndex = playedChunkIndex + 1;
    // Mark old chunks as played to free up memory
    for (let item of this.queue) {
      if (item.chunkIndex <= playedChunkIndex) {
         item.status = 'played';
         item.audioBase64 = null; // Free memory
      }
    }
    this.processQueue();
  }

  async processQueue() {
    if (this.isSynthesizing) return;
    
    const toSynthesize = this.queue.find(item => item.status === 'pending');
    if (!toSynthesize || (toSynthesize.chunkIndex - this.currentPlayIndex >= this.lookahead)) {
      return;
    }

    this.isSynthesizing = true;
    toSynthesize.status = 'synthesizing';

    try {
      console.log(`[TTS] Synthesizing chunk ${toSynthesize.chunkIndex}...`);
      
      // Map phase to style prefix
      const stylePrefixMap = {
        setup:          '[speak slowly and warmly]',
        greeting:       '[speak slowly and warmly]',
        narration:      '[speak slowly and warmly]',
        qa_answer:      '[speak conversationally]',
        closing:        '[speak slowly and warmly]',
      };

      const prefix = stylePrefixMap[toSynthesize.phase] || '[speak slowly and warmly]';
      const prompt = `${prefix} ${toSynthesize.text}`;
      
      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: prompt
      });

      // Extract raw audio data (Base64) from the response parts
      let inlineData = null;
      if (response.candidates && response.candidates[0].content.parts) {
         const parts = response.candidates[0].content.parts;
         const audioPart = parts.find(p => p.inlineData && p.inlineData.data);
         if (audioPart) {
             inlineData = audioPart.inlineData.data;
         }
      }

      if (inlineData) {
        toSynthesize.audioBase64 = inlineData;
        toSynthesize.status = 'ready';
        
        // Send to client immediately
        this.socket.send(JSON.stringify({
           type: 'tts_audio',
           data: toSynthesize.audioBase64,
           chunkIndex: toSynthesize.chunkIndex
        }));
      } else {
        console.warn(`[TTS] No audio data returned for chunk ${toSynthesize.chunkIndex}`);
        toSynthesize.status = 'played'; // Skip it
      }
      
    } catch(e) {
      console.error(`[TTS] Synthesis error for chunk ${toSynthesize.chunkIndex}:`, e);
      toSynthesize.status = 'played'; // Skip on error to avoid blocking the queue
    } finally {
      this.isSynthesizing = false;
      // Recursively process until lookahead limit is reached
      this.processQueue();
    }
  }
}

module.exports = { TTSPipeline };
