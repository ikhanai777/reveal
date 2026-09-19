// Small synchronous hash used for the signal log's tamper-evident chain.
//
// This is an integrity check, not a security primitive: it detects accidental
// or casual edits to the log, and it runs synchronously in every runtime
// (WebCrypto's digest is async and unavailable on insecure origins). For a
// log that must resist a motivated attacker, chain with an HMAC signed
// server-side instead — `chainEntry` takes the digest function as an argument
// precisely so that swap is a one-line change.

/** FNV-1a run twice with different offsets, concatenated to 64 bits of hex. */
export function fnv1a64(str) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c + i; h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/** Stable stringify: key order must not change a record's digest. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** Digest of `record` bound to `prevHash`, forming an append-only chain. */
export function chainEntry(record, prevHash = '0'.repeat(16), digest = fnv1a64) {
  return digest(`${prevHash}|${stableStringify(record)}`);
}

/**
 * Verify a chain. Returns the index of the first broken link, or -1 when the
 * whole chain is intact.
 */
export function verifyChain(entries, digest = fnv1a64) {
  let prev = '0'.repeat(16);
  for (let i = 0; i < entries.length; i++) {
    const { hash, prevHash, ...record } = entries[i];
    if (prevHash !== prev) return i;
    if (chainEntry(record, prev, digest) !== hash) return i;
    prev = hash;
  }
  return -1;
}
