/**
 * Reading the text layer out of an uploaded PDF.
 *
 * The 0017 migration header gives three reasons the `extracted_text` column is
 * filled at upload time from whatever the uploader supplies, and the third is
 * the one this module has to answer: parsing a PDF inside the upload path adds
 * a dependency and a failure mode to the one path that must never lose the
 * hash. That objection is met by construction rather than by care — nothing in
 * here can throw, nothing in here can hang, and the worst outcome it is capable
 * of is `null`, which is exactly the value the column already holds for every
 * document nobody typed a caption for. A PDF that defeats the parser leaves the
 * upload byte-for-byte identical to how it lands today.
 *
 * What it buys is the difference between a repair estimate the adjudicator is
 * told exists and one it can actually read. Two thirds of the prompt's
 * DOCUMENTS block is currently the sentence "nothing has been read out of it",
 * and a document the model cannot read is a document that silently corroborates
 * whatever the claimant said.
 *
 * The text this produces is still fenced and still sanitised downstream. A
 * garage's invoice can contain `</document>` and an instruction as easily as a
 * claimant's caption can; `pdf_text` says the bytes were machine-read, not that
 * the words in them are friendly.
 */

/**
 * Longest text kept from one file. Matches MAX_EXTRACTED_TEXT_CHARS in
 * `routes/claim-documents.ts` deliberately: a machine-read estimate and a
 * hand-typed one end up in the same column, reach the same prompt, and have no
 * business being bounded differently. Twenty thousand characters is around ten
 * pages of dense text, which is more than any repair estimate or police report
 * needs and far less than a PDF can be made to emit.
 */
export const MAX_PDF_TEXT_CHARS = 20_000;

/**
 * Pages read before we stop.
 *
 * A PDF's page count is attacker-controlled and costs almost nothing to inflate
 * — the fixture in `test-fixtures/pdf/many-pages.pdf` is twelve pages in 17 kB,
 * so the 10 MB upload ceiling permits something in the thousands. Forty pages
 * is past where the character cap bites for any real document, so in practice
 * this bound only ever fires on a file built to make it fire.
 */
export const MAX_PDF_PAGES = 40;

/**
 * How long extraction is allowed to take before we stop.
 *
 * Smaller than DEFAULT_ARCHIVE_TIMEOUT_MS, and spent against the same thing:
 * a claimant watching a spinner in the call widget mid-call. The caller runs
 * this alongside archival rather than after it, so on the normal path it costs
 * nothing at all — a twelve-page document parses in single-digit milliseconds.
 *
 * It is enforced twice, because one enforcement is not enough. A timer races
 * the whole operation, which is what bounds a parser stuck waiting on
 * something. That timer on its own is close to decorative for the case that
 * actually worries us: pdf.js chunks its work through microtasks, and a
 * microtask queue that never drains is a timer that never fires, so a file
 * built to be expensive to parse would burn the CPU with the alarm clock
 * sitting unread behind it. So the page loop also checks the clock between
 * pages and stops when the budget is gone. That check is the one with teeth.
 */
export const PDF_EXTRACTION_BUDGET_MS = 4_000;

/** Server-side policy for one extraction. Every value has a documented default. */
export interface PdfTextOptions {
  maxChars?: number;
  maxPages?: number;
  budgetMs?: number;
}

/**
 * The PDF header, and how far into the file it is tolerated.
 *
 * Byte 0 is where the specification puts it, but readers have accepted a
 * header preceded by junk for as long as there have been readers, and so does
 * the parser underneath this module. Scanning the same small window means this
 * function agrees with what will actually be parsed rather than turning away a
 * file the parser would have read.
 */
const PDF_MAGIC = '%PDF-';
const PDF_MAGIC_WINDOW = 1024;

/**
 * Whether these bytes are a PDF, decided by looking at them.
 *
 * The stated MIME type is not consulted, and that is the point: it arrives in a
 * multipart body that anyone holding the URL can post, so it is a claim about
 * the file rather than a fact about it. A JPEG labelled `application/pdf` must
 * not be handed to a PDF parser, and a PDF labelled `image/png` — which gate 4
 * in `claim-documents-service.ts` accepts, because the label is all it has — is
 * still a PDF and still worth reading.
 */
export function looksLikePdf(bytes: Uint8Array): boolean {
  if (!bytes || bytes.byteLength < PDF_MAGIC.length) return false;

  const window = bytes.subarray(0, PDF_MAGIC_WINDOW);
  for (let start = 0; start + PDF_MAGIC.length <= window.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < PDF_MAGIC.length; offset += 1) {
      if (window[start + offset] !== PDF_MAGIC.charCodeAt(offset)) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }

  return false;
}

/**
 * Read the text layer out of a PDF, or return null.
 *
 * Null is a real answer with four distinct meanings behind it — these bytes are
 * not a PDF, this PDF is a scan with no text layer, this PDF is corrupt, or we
 * ran out of the time we could keep a caller waiting — and the caller treats
 * all four the same way, because all four leave us with nothing we are entitled
 * to write into `extracted_text`. The reason is logged rather than returned:
 * which of the four it was matters to whoever reads the logs and to nobody on
 * the phone.
 *
 * This function does not throw. Callers rely on that rather than on their own
 * try/catch, because the thing it is protecting — the hash and the document row
 * — is written after this runs and must not be reachable by an exception raised
 * inside a PDF parser.
 */
export async function extractPdfText(
  bytes: Uint8Array,
  options: PdfTextOptions = {}
): Promise<string | null> {
  if (!looksLikePdf(bytes)) return null;

  const maxChars = options.maxChars ?? MAX_PDF_TEXT_CHARS;
  const maxPages = options.maxPages ?? MAX_PDF_PAGES;
  const budgetMs = options.budgetMs ?? PDF_EXTRACTION_BUDGET_MS;

  /**
   * A copy, made before anything else happens, and not an optimisation to be
   * removed later. pdf.js transfers the buffer it is given to its worker, which
   * detaches it — the array the caller still holds becomes zero-length. Those
   * are the bytes being hashed and archived on the same code path, so handing
   * the original over would substitute an empty file for the claimant's
   * evidence, which is the precise class of failure this repository's v1
   * shipped and 0013 was written about.
   */
  const owned = new Uint8Array(bytes);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      console.warn(
        `extractPdfText: gave up after ${budgetMs} ms; the document is recorded without text`
      );
      resolve(null);
    }, budgetMs);
    // Unref'd for the same reason the archival timer is: a pending timer would
    // hold the event loop open long after the response has gone out.
    timer.unref?.();
  });

  try {
    // The race stops us waiting; it does not stop the parser. Whatever pdf.js
    // is doing carries on until it finishes and is then dropped on the floor,
    // exactly as a timed-out archival upload is. What keeps that bounded is not
    // this line but the deadline and the page cap inside `readPages`.
    return await Promise.race([
      readPages(owned, maxPages, maxChars, Date.now() + budgetMs),
      expiry,
    ]);
  } catch (err) {
    // Nothing reaches here on any path the parser is documented to take; it is
    // the one that matters. `Invalid PDF structure` on a truncated file arrives
    // as a rejection, and a rejection escaping this function would cost the
    // claimant the record of a file we had already received and hashed.
    console.warn(
      `extractPdfText: could not read the document (${err instanceof Error ? err.message : String(err)})`
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Walk the pages and concatenate their text items.
 *
 * Done by hand rather than through unpdf's own `extractText`, which reads every
 * page there is. The page cap is the only bound that holds against a document
 * built to be expensive, so it has to be applied while the pages are being
 * read, not after.
 *
 * The import is dynamic so that the bundled pdf.js — which is several megabytes
 * and is needed by exactly one branch of one route — is not paid for at boot by
 * a process that mostly answers health checks. It also means a broken install
 * of the dependency degrades to "no text extracted" rather than to a server
 * that will not start.
 */
async function readPages(
  bytes: Uint8Array,
  maxPages: number,
  maxChars: number,
  deadline: number
): Promise<string | null> {
  const { getDocumentProxy } = await import('unpdf');

  const document = await getDocumentProxy(bytes, {
    // Off because reading a text layer needs no fonts at all, and leaving it on
    // lets a document we did not write decide which files on this machine get
    // opened while it is parsed.
    useSystemFonts: false,
    // pdf.js warns on stderr about missing standard font data for every page of
    // every document that names a built-in font, which is all of them. Nothing
    // here renders anything, so the warning is noise in the API logs.
    verbosity: 0,
  });

  const pages = Math.min(document.numPages, maxPages);
  if (pages < document.numPages) {
    console.warn(
      `extractPdfText: reading ${pages} of ${document.numPages} pages; the rest are past the page cap`
    );
  }

  let text = '';

  try {
    for (let pageNumber = 1; pageNumber <= pages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();

      for (const item of content.items) {
        // Marked-content items carry no `str` at all. Testing for it rather
        // than casting keeps a shape change in pdf.js from becoming `undefined`
        // spliced into the middle of a repair estimate.
        if (typeof (item as { str?: unknown }).str !== 'string') continue;
        const fragment = item as { str: string; hasEOL?: boolean };
        text += fragment.hasEOL ? `${fragment.str}\n` : fragment.str;
      }

      page.cleanup();

      // Both stops keep what has already been read rather than discarding it,
      // and for the same reason the page cap does: the first pages of a repair
      // estimate are still worth cross-checking a claim against, and throwing
      // them away would leave the adjudicator with the "nothing has been read
      // out of it" line for a document we had in fact read most of.
      if (text.length >= maxChars) break;

      if (Date.now() >= deadline) {
        console.warn(
          `extractPdfText: out of time after ${pageNumber} of ${document.numPages} pages; keeping what was read`
        );
        break;
      }
    }
  } finally {
    // The proxy holds a worker and the parsed document behind it. This process
    // is a long-lived API server, so not releasing them would be a leak that
    // grows by one document per upload.
    await document.loadingTask?.destroy();
  }

  const trimmed = text.trim();

  // Whitespace is not text. A scan has no text layer at all, and a page that
  // yields nothing but spaces is the same document as far as anyone reading it
  // is concerned — recording `''` would let the 0017 constraint pair an empty
  // string with a stated source, which asserts that somebody read the file and
  // found it blank.
  if (!trimmed) {
    console.warn('extractPdfText: the document has no text layer, so nothing was recorded');
    return null;
  }

  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}
