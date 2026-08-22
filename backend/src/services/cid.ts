import { createHash } from 'node:crypto';

/** RFC 4648 base32, lowercase, unpadded — the multibase 'b' encoding. */
function base32(bytes: Uint8Array): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

/**
 * CIDv1 over the raw codec with a sha2-256 multihash.
 * Prefix bytes: 0x01 version, 0x55 raw codec, 0x12 sha2-256, 0x20 digest length.
 *
 * This is a genuine content address: anyone holding the same bytes derives the
 * same CID. It says nothing about whether those bytes were ever uploaded.
 */
export function cidForBytes(data: Uint8Array): string {
  const digest = createHash('sha256').update(data).digest();
  const prefixed = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]);
  return 'b' + base32(prefixed);
}
