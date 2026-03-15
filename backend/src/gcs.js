const { Storage } = require('@google-cloud/storage');

const storage = new Storage();
const BUCKET_NAME = 'fable-genie-assets';

/**
 * Gets a signed URL for a video file
 * @param {string} filename 'trust_resolution.mp4' or 'run_away_resolution.mp4'
 * @returns {Promise<string>}
 */
async function getSignedUrl(filename) {
  try {
    const options = {
      version: 'v4',
      action: 'read',
      expires: Date.now() + 15 * 60 * 1000, // 15 minutes
    };

    const [url] = await storage
      .bucket(BUCKET_NAME)
      .file(filename)
      .getSignedUrl(options);

    return url;
  } catch (error) {
    console.error('Error generating signed URL:', error);
    throw error;
  }
}

module.exports = { getSignedUrl };
