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
 * @param {string} text - the story chunk text
 * @param {string|null} setting - optional story setting for context
 * @returns {Promise<string>}
 */
async function getVisualPrompt(text, setting) {
  try {
    const ai = getGenAI();

    const settingContext = setting
      ? `\nStory setting: "${setting}" \u2014 visuals must match this world.`
      : '';

    const prompt = `
Describe a single core visual scene from the story snippet below. 
The description must be:
- Concise (10-15 words max)
- Purely visual (no abstract concepts)
- Focused on subjects, colors, and environment
- Styled for a children's storybook watercolor illustration
- Consistent with the story's world and setting
${settingContext}
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
