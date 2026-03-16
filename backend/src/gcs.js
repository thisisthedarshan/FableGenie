const { Storage } = require('@google-cloud/storage');

// Signed URLs require a service account key with client_email.
// On Cloud Run: the attached service account handles this automatically.
// Locally with ADC: signing fails because ADC uses a user credential,
// not a service account key. Two options are available:
//
// Option A (recommended for local dev):
//   Download a service account key JSON from GCP Console:
//   IAM → Service Accounts → fable-genie-sa → Keys → Add Key → JSON
//   Set GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json in your .env
//   The Storage client will pick it up automatically.
//
// Option B (quick local workaround — no key needed):
//   Make the GCS bucket publicly readable (already done in deploy.sh)
//   and use plain public URLs instead of signed URLs.
//   Set GCS_USE_PUBLIC_URLS=true in your .env for local dev.
//   NEVER set this in production — use signed URLs there.

const BUCKET_NAME = process.env.GCS_BUCKET || 'fable-genie-assets';
const USE_PUBLIC_URLS = process.env.GCS_USE_PUBLIC_URLS === 'true';

let storageClient = null;

function getStorage() {
  if (!storageClient) {
    storageClient = new Storage();
  }
  return storageClient;
}

async function getSignedUrl(filename) {
  // Option B: public URL (local dev only)
  if (USE_PUBLIC_URLS) {
    const publicUrl = `https://storage.googleapis.com/${BUCKET_NAME}/${filename}`;
    console.log(`[GCS] Using public URL for: ${filename}`);
    return publicUrl;
  }

  // Option A: signed URL (Cloud Run + service account key)
  try {
    const [url] = await getStorage()
      .bucket(BUCKET_NAME)
      .file(filename)
      .getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + 15 * 60 * 1000, // 15 minutes
      });
    console.log(`[GCS] Signed URL generated for: ${filename}`);
    return url;
  } catch (e) {
    console.error(`[GCS] Error generating signed URL: ${e.message}`);

    // Helpful hint if it's the client_email error
    if (e.message && e.message.includes('client_email')) {
      console.error('[GCS] Fix: Set GCS_USE_PUBLIC_URLS=true in .env for local dev,');
      console.error('[GCS]      OR set GOOGLE_APPLICATION_CREDENTIALS to a service account key JSON.');
    }

    return null;
  }
}

module.exports = { getSignedUrl };