const { GoogleGenAI } = require('@google/genai');

let genAI = null;
function getGenAI() {
  if (!genAI) {
    genAI = new GoogleGenAI({
      vertexai: true,
      project: process.env.GOOGLE_CLOUD_PROJECT,
      location: process.env.VERTEX_AI_LOCATION || 'us-central1',
    });
  }
  return genAI;
}

const MODEL_NAME = 'gemini-2.5-flash';

/**
 * Converts a story chunk into a concise visual prompt for Imagen.
 * @param {string} text 
 * @returns {Promise<string>}
 */
async function getVisualPrompt(text) {
  try {
    const ai = getGenAI();
    const prompt = `
Describe a single core visual scene from the story snippet below. 
The description must be:
- Concise (10-15 words max)
- Purely visual (no abstract concepts)
- Focused on subjects, colors, and environment
- Styled for a children's storybook watercolor illustration

Text: "${text}"

Visual Prompt:`.trim();

    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    });

    const result = response.candidates?.[0]?.content?.parts?.[0]?.text;
    return result ? result.trim() : "A cozy magical scene";
  } catch (e) {
    console.warn('[ImagePrompter] Failed to generate visual prompt:', e.message);
    return "A cozy magical scene";
  }
}

module.exports = { getVisualPrompt };
