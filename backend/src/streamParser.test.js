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

assert.deepStrictEqual(texts, ['Hello, this is a ', '. More text.']);
assert.deepStrictEqual(images, ['test image']);
assert.deepStrictEqual(moods, []);

console.log('StreamParser tests passed.');
