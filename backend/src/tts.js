const { GoogleGenAI } = require('@google/genai');

let genAI = null;
function getGenAI() {
  if (!genAI) {
    genAI = new GoogleGenAI({
      vertexai: true,
      project: process.env.GOOGLE_CLOUD_PROJECT,
      location: process.env.VERTEX_AI_LOCATION,
    });
  }
  return genAI;
}

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
    for (let item of this.queue) {
      if (item.chunkIndex <= playedChunkIndex) {
        item.status = 'played';
        item.audioBase64 = null;
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

      const stylePrefixMap = {
        setup: '[speak slowly and warmly]',
        greeting: '[speak slowly and warmly]',
        narration: '[speak slowly and warmly]',
        qa_answer: '[speak conversationally]',
        closing: '[speak slowly and warmly]',
      };

      const prefix = stylePrefixMap[toSynthesize.phase] || '[speak slowly and warmly]';
      const prompt = `${prefix} ${toSynthesize.text}`;

      const ai = getGenAI();

      const response = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: 'Kore'
              }
            }
          }
        }
      });

      let inlineData = null;
      if (response && response.candidates && response.candidates[0].content && response.candidates[0].content.parts) {
        const parts = response.candidates[0].content.parts;
        const audioPart = parts.find(p => p.inlineData && p.inlineData.data);
        if (audioPart) {
          inlineData = audioPart.inlineData;
        }
      }

      if (inlineData) {
        toSynthesize.audioBase64 = inlineData.data;
        toSynthesize.status = 'ready';

        this.socket.send(JSON.stringify({
          type: 'tts_audio',
          data: toSynthesize.audioBase64,
          // Send mimeType so frontend can decode correctly.
          // gemini-2.5-flash-preview-tts returns raw PCM (audio/pcm;rate=24000)
          // NOT WAV — decodeAudioData will fail on it.
          mimeType: inlineData.mimeType || 'audio/pcm;rate=24000',
          chunkIndex: toSynthesize.chunkIndex
        }));
        console.log(`[TTS] Chunk ${toSynthesize.chunkIndex} ready — mimeType: ${inlineData.mimeType || 'unknown'}`);
      } else {
        console.warn(`[TTS] No audio data returned for chunk ${toSynthesize.chunkIndex}`);
        toSynthesize.status = 'played';
      }

    } catch (e) {
      console.error(`[TTS] Synthesis error for chunk ${toSynthesize.chunkIndex}:`, e);
      toSynthesize.status = 'played';
    } finally {
      this.isSynthesizing = false;
      this.processQueue();
    }
  }
}

module.exports = { TTSPipeline };