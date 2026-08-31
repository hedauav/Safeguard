import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  MAX_PDF_PAGES,
  MAX_PDF_TEXT_CHARS,
  extractPdfText,
  looksLikePdf,
} from './pdf-text.js';

// --- Fixtures ---------------------------------------------------------------
// Real files, read off disk, written by `scripts/make-pdf-fixtures.mjs`. What
// is under test is a parser's behaviour on documents, and a document assembled
// inside the test would only ever be as adversarial as the test author
// remembered to make it. Resolved against this module's own URL rather than
// the working directory, so the suite does not depend on where it was started.
const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../test-fixtures/pdf/${name}`, import.meta.url)));

const WITH_TEXT_LAYER = fixture('with-text-layer.pdf');
const IMAGE_ONLY = fixture('image-only.pdf');
const CORRUPT = fixture('corrupt.pdf');
const MANY_PAGES = fixture('many-pages.pdf');

/** A PNG header and a few bytes of nothing — the ordinary non-PDF upload. */
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

// --- Reading a document that can be read ------------------------------------

test('the text layer of a repair estimate is read out of the bytes', async () => {
  const text = await extractPdfText(WITH_TEXT_LAYER);

  assert.ok(text, 'a document with a text layer must produce text');
  assert.match(text, /SHARMA AUTO WORKS/);
  assert.match(text, /Total: INR 34,500/, 'the figure is the whole reason to read the file');
  assert.equal(text, text.trim(), 'nothing is recorded with leading or trailing whitespace');
});

test('the bytes handed in are still there after the parse', async () => {
  // pdf.js transfers the buffer it is given to its worker, which detaches it.
  // These are the bytes being hashed and archived on the same code path, so a
  // parser that ate them would substitute an empty file for the claimant's
  // evidence. The copy that prevents that is invisible from outside; this is
  // the only thing that would notice it being removed.
  const before = Array.from(WITH_TEXT_LAYER);
  await extractPdfText(WITH_TEXT_LAYER);

  assert.equal(WITH_TEXT_LAYER.byteLength, before.length, 'the caller still holds its bytes');
  assert.deepEqual(Array.from(WITH_TEXT_LAYER), before, 'and they are the same bytes');
});

// --- Reading a document that cannot be read ---------------------------------

test('a scan with no text layer is nothing read, not an empty string', async () => {
  const text = await extractPdfText(IMAGE_ONLY);

  // Null and '' are different claims: one says nobody has read this file, the
  // other says somebody read it and found it blank. The 0017 constraint pairs
  // any non-null text with a stated source, so '' would assert the second.
  assert.equal(text, null);
});

test('a corrupt document is given up on rather than thrown out of', async () => {
  const text = await extractPdfText(CORRUPT);
  assert.equal(text, null, 'the parser rejecting must arrive as a value, never as an exception');
});

test('a file that is not a PDF is never offered to the parser', async () => {
  assert.equal(await extractPdfText(PNG), null);
  assert.equal(await extractPdfText(new Uint8Array()), null);
  assert.equal(await extractPdfText(new Uint8Array([0x25])), null);
});

// --- What a hostile file cannot make us do ----------------------------------

test('pages past the cap are not read', async () => {
  const capped = await extractPdfText(MANY_PAGES, { maxPages: 3 });

  assert.ok(capped);
  assert.match(capped, /PAGE 1 OF 12/, 'the pages within the cap are read');
  assert.match(capped, /PAGE 3 OF 12/);
  assert.ok(!capped.includes('PAGE 4 OF 12'), 'and the cap holds against a longer document');
  assert.ok(!capped.includes('PAGE 12 OF 12'));
});

test('a budget that has already run out stops the reader part-way', async () => {
  // Deliberately loose about what comes back. A budget of zero can be spent
  // either by the timer or by the between-pages check depending on which side
  // of a microtask boundary the parser happens to be on, and the two answer
  // with null and with partial text respectively. Both are correct; what
  // matters is that neither reads to the end of the document and neither
  // throws.
  const rushed = await extractPdfText(MANY_PAGES, { budgetMs: 0 });

  assert.ok(rushed === null || !rushed.includes('PAGE 12 OF 12'), 'the budget is honoured');
});

test('text past the character cap is cut off rather than carried', async () => {
  const capped = await extractPdfText(MANY_PAGES, { maxChars: 200 });

  assert.ok(capped);
  assert.ok(capped.length <= 200, `expected at most 200 characters, got ${capped.length}`);
  assert.match(capped, /PAGE 1 OF 12/, 'the cut keeps the beginning of the document');
});

test('the whole document is read when nothing caps it', async () => {
  const full = await extractPdfText(MANY_PAGES);

  assert.ok(full);
  assert.match(full, /PAGE 12 OF 12/, 'a twelve-page document is well inside every default');
  assert.ok(full.length <= MAX_PDF_TEXT_CHARS);
  assert.ok(12 <= MAX_PDF_PAGES, 'the fixture is only a test of the caps if it fits under them');
});

// --- Deciding what is a PDF -------------------------------------------------

test('a PDF is recognised by its bytes and not by what it is called', () => {
  assert.equal(looksLikePdf(WITH_TEXT_LAYER), true);
  assert.equal(looksLikePdf(CORRUPT), true, 'a truthful header on a broken body is still a PDF');
  assert.equal(looksLikePdf(PNG), false);
  assert.equal(looksLikePdf(new Uint8Array()), false);
});

test('a header sitting behind junk is still recognised, and one past the window is not', () => {
  // Readers have tolerated a header preceded by rubbish for as long as there
  // have been readers, and so does the parser underneath this module. Turning
  // such a file away here would mean refusing to read a document that pdf.js
  // would have read perfectly well.
  const buried = new Uint8Array([...new Uint8Array(64).fill(0x20), ...WITH_TEXT_LAYER]);
  assert.equal(looksLikePdf(buried), true);

  const beyond = new Uint8Array([...new Uint8Array(2048).fill(0x20), ...WITH_TEXT_LAYER]);
  assert.equal(looksLikePdf(beyond), false, 'the scan is bounded, so a header can be hidden past it');
});
