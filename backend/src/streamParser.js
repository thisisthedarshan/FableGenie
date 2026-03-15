const { EventEmitter } = require('events');

class StreamParser extends EventEmitter {
  constructor() {
    super();
    this.buffer = '';
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
        // No open bracket, everything is safe text
        this.emitText(this.buffer);
        this.buffer = '';
        return;
      }

      if (openIdx > 0) {
        // We have text before the bracket
        this.emitText(this.buffer.slice(0, openIdx));
        this.buffer = this.buffer.slice(openIdx);
        // continue loop
        continue;
      }

      // openIdx === 0, we are at the start of a potential tag
      const closeIdx = this.buffer.indexOf(']');
      
      if (closeIdx === -1) {
        // Tag not complete yet, wait for more chunks
        return;
      }

      // We have a complete tag inside brackets
      const tagContent = this.buffer.slice(1, closeIdx).trim();
      const rawTag = this.buffer.slice(0, closeIdx + 1);
      
      this.buffer = this.buffer.slice(closeIdx + 1);
      this.handleTag(tagContent, rawTag);
    }
  }

  emitText(text) {
    if (text.trim().length > 0) {
      this.emit('text', text);
    }
  }

  handleTag(tagContent, rawTag) {
    if (tagContent.startsWith('IMAGE:')) {
      const desc = tagContent.replace('IMAGE:', '').trim();
      this.emit('imageTag', desc);
    } else if (tagContent.startsWith('MUSIC_MOOD:')) {
      const mood = tagContent.replace('MUSIC_MOOD:', '').trim();
      this.emit('moodTag', mood);
    } else if (tagContent.startsWith('MICRO_MOMENT:')) {
      const question = tagContent.replace('MICRO_MOMENT:', '').trim();
      this.emit('microMoment', question);
    } else if (tagContent === 'BRANCH_CHOICE') {
      this.emit('branchChoice');
    } else if (tagContent === 'STORY_END') {
      this.emit('storyEnd');
    } else {
      // False alarm, not one of our structural tags, emit as text
      this.emitText(rawTag);
    }
  }
}

module.exports = StreamParser;
