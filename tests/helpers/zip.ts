import { expect } from "@jest/globals";
import * as zlib from "zlib";

/** The textbook bit-by-bit CRC-32, written apart from scripts/zip.js so that the two can disagree. */
export const bitwiseCrc32 = (buf: Buffer): number => {
  let c = 0xffffffff;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
};

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  localFlags: number;
  crc: number;
  usize: number;
  data: Buffer;
}

/** A zip reader written for the tests (central directory only, as unzip does): name, method, stored checksum and inflated content of each entry. */
export const readZip = (zip: Buffer): ZipEntry[] => {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThan(0);
  const count = zip.readUInt16LE(end + 10);
  let pos = zip.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(pos)).toBe(0x02014b50);
    const flags = zip.readUInt16LE(pos + 8);
    const method = zip.readUInt16LE(pos + 10);
    const crc = zip.readUInt32LE(pos + 16);
    const csize = zip.readUInt32LE(pos + 20);
    const usize = zip.readUInt32LE(pos + 24);
    const nameLen = zip.readUInt16LE(pos + 28);
    const offset = zip.readUInt32LE(pos + 42);
    const name = zip.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");
    const dataStart = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const body = zip.subarray(dataStart, dataStart + csize);
    expect([0, 8]).toContain(method);
    entries.push({ name, method, flags, localFlags: zip.readUInt16LE(offset + 6), crc, usize, data: method === 8 ? zlib.inflateRawSync(body) : body });
    pos += 46 + nameLen;
  }
  return entries;
};
