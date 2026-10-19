import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";

export { bytesToHex, hexToBytes, randomBytes };

export function utf8ToBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** Node's `Buffer`, where the runtime has one; the browser and Hermes use the fallbacks below. */
type NodeBufferCtor = {
  from(
    data: ArrayBufferLike | string,
    offsetOrEncoding?: number | "base64",
    length?: number,
  ): Uint8Array & { toString(encoding: "base64"): string };
};

export function bytesToBase64(bytes: Uint8Array): string {
  const Buf = (globalThis as { Buffer?: NodeBufferCtor }).Buffer;
  if (Buf) {
    return Buf.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  }
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return globalThis.btoa(binary);
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Unpadded base64url, as WebAuthn JSON and API tokens carry binary. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let c = 0; c < chars; c++) out += B64URL[(n >> (18 - 6 * c)) & 63];
  }
  return out;
}

/** Decode unpadded base64url; null when `text` holds anything else. */
export function base64UrlToBytes(text: string): Uint8Array | null {
  const bytes: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of text) {
    const v = B64URL.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

export function base64ToBytes(b64: string): Uint8Array {
  const Buf = (globalThis as { Buffer?: NodeBufferCtor }).Buffer;
  if (Buf) {
    const buf = Buf.from(b64, "base64");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const binary = globalThis.atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
