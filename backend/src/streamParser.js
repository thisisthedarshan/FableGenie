const { EventEmitter } = require('events');

// Minimum characters to accumulate before emitting a text chunk to TTS.
// Small chunks = many small API calls = gaps between sentences.
// Larger chunks = fewer calls = smoother narration flow.
const MIN_CHUNK_CHARS = 100;

class StreamParser extends EventEmitter {
  constructor() {
    super();
    this.buffer = '';      // raw incoming stream buffer (tag-aware)
    this.textAccum = '';   // accumulated clean text waiting to be emitted
    this.inTag = false;
  }

  feed(chunk) {
    this.buffer += chunk;
    this.processBuffer();
  }

  processBuffer() {
    while (this.buffer.length > 0) {
      const openIdx = this.buffer.indexOf('[');

      if (openIdx === -1) {
        // No tag in sight — accumulate all as text
        this.accumText(this.buffer);
        this.buffer = '';
        return;
      }

      if (openIdx > 0) {
        // Text before the bracket
        this.accumText(this.buffer.slice(0, openIdx));
        this.buffer = this.buffer.slice(openIdx);
        continue;
      }

      // At start of a potential tag
      const closeIdx = this.buffer.indexOf(']');
      if (closeIdx === -1) {
        // Tag not complete yet — wait for more chunks
        return;
      }

      const tagContent = this.buffer.slice(1, closeIdx).trim();
      const rawTag = this.buffer.slice(0, closeIdx + 1);
      this.buffer = this.buffer.slice(closeIdx + 1);

      // Flush accumulated text BEFORE processing the tag
      this.flushText();
      this.handleTag(tagContent, rawTag);
    }
  }

  // Accumulate text and flush when chunk is large enough or sentence ends
  accumText(text) {
    if (!text) return;
    this.textAccum += text;

    // Flush on sentence boundary if we have enough text
    const lastChar = this.textAccum.trimEnd().slice(-1);
    const isSentenceEnd = ['.', '!', '?'].includes(lastChar);

    if (this.textAccum.length >= MIN_CHUNK_CHARS && isSentenceEnd) {
      this.flushText();
    }
  }

  flushText() {
    const text = this.textAccum.trim();
    if (text.length > 0) {
      this.emit('text', text);
    }
    this.textAccum = '';
  }

  handleTag(tagContent, rawTag) {
    if (tagContent.startsWith('IMAGE:')) {
      this.emit('imageTag', tagContent.replace('IMAGE:', '').trim());
    } else if (tagContent.startsWith('MUSIC_MOOD:')) {
      this.emit('moodTag', tagContent.replace('MUSIC_MOOD:', '').trim());
    } else if (tagContent.startsWith('MICRO_MOMENT:')) {
      this.emit('microMoment', tagContent.replace('MICRO_MOMENT:', '').trim());
    } else if (tagContent === 'BRANCH_CHOICE') {
      this.emit('branchChoice');
    } else if (tagContent === 'STORY_END') {
      this.emit('storyEnd');
    } else {
      // Unknown tag — treat as literal text
      this.accumText(rawTag);
    }
  }
}

module.exports = StreamParser;