require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

(async () => {
    try {
      const ai = new GoogleGenAI({ 
        vertexai: true,
        project: process.env.GOOGLE_CLOUD_PROJECT,
        location: process.env.VERTEX_AI_LOCATION
      });
      console.log('Synchronously initialized GoogleGenAI');
      
      const session = await ai.live.connect({
          model: 'gemini-live-2.5-flash-native-audio',
          callbacks: {
              onmessage: (msg) => {
                  console.log("Received server message:", msg);
              },
              onerror: (err) => console.error("Error from socket", err),
              onclose: () => console.log("Socket closed.")
          }
      });
      // Try network call
      await session.sendClientContent({
          turns: [{
              role: "user",
              parts: [{ text: "hello" }]
          }],
          turnComplete: true
      });
    } catch (e) {
      console.error("Failed to initialize GoogleGenAI", e);
    }
})();
