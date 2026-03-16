const assert = require('assert');
const StreamParser = require('./streamParser');

const parser = new StreamParser();
let texts = [];
let images = [];
let moods = [];

parser.on('text', t => texts.push(t));
parser.on('imageTag', img => images.push(img));
parser.on('moodTag', mood => moods.push(mood));

parser.feed('Hello, this is a [I');
parser.feed('MAGE: test image');
parser.feed(']. More text.');

// Flush any remaining buffered text (simulates stream end)
parser.flushText();

// With MIN_CHUNK_CHARS = 100, short text chunks stay buffered until
// either a sentence boundary + min length is reached, or flushText() is called.
// "Hello, this is a " is flushed before the tag.
// ". More text." is flushed at the end by flushText().
assert.deepStrictEqual(texts, ['Hello, this is a', '. More text.']);
assert.deepStrictEqual(images, ['test image']);
assert.deepStrictEqual(moods, []);

console.log('StreamParser tests passed.');

