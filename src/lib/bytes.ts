// Copy into a fresh ArrayBuffer-backed array. Also narrows Uint8Array<ArrayBufferLike>
// (e.g. a subarray view) to Uint8Array<ArrayBuffer>, which Bun's crypto/inflate APIs require.
export function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
