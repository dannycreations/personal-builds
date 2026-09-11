import { closeSync, openSync, readSync, statSync } from 'node:fs';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const EOCD_RECORD_SIZE = 22;
const CENTRAL_DIRECTORY_HEADER_SIZE = 46;
const EOCD_SEARCH_WINDOW = 65535 + 100; // max ZIP comment length, plus room for the EOCD record itself

function readFileAt(filePath: string, offset: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const fd = openSync(filePath, 'r');
  try {
    readSync(fd, buffer, 0, length, offset);
  } finally {
    closeSync(fd);
  }
  return buffer;
}

function readFileTail(filePath: string, size: number): Buffer {
  const { size: fileSize } = statSync(filePath);
  const readSize = Math.min(fileSize, size);
  return readFileAt(filePath, fileSize - readSize, readSize);
}

function findEndOfCentralDirectory(tail: Buffer): number {
  for (let i = tail.length - EOCD_RECORD_SIZE; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

function centralDirectoryContainsApkEntry(centralDirectory: Buffer, entryCount: number): boolean {
  let offset = 0;

  for (let i = 0; i < entryCount; i++) {
    if (offset + CENTRAL_DIRECTORY_HEADER_SIZE > centralDirectory.length) break;
    if (centralDirectory.readUInt32LE(offset) !== CENTRAL_DIRECTORY_SIGNATURE) break;

    const filenameLength = centralDirectory.readUInt16LE(offset + 28);
    const extraLength = centralDirectory.readUInt16LE(offset + 30);
    const commentLength = centralDirectory.readUInt16LE(offset + 32);
    const entrySize = CENTRAL_DIRECTORY_HEADER_SIZE + filenameLength + extraLength + commentLength;
    if (offset + entrySize > centralDirectory.length) break;

    if (filenameLength >= 4) {
      const nameEnd = offset + CENTRAL_DIRECTORY_HEADER_SIZE + filenameLength;
      const isDotApk =
        centralDirectory[nameEnd - 4] === 0x2e &&
        (centralDirectory[nameEnd - 3] & 0xdf) === 0x61 &&
        (centralDirectory[nameEnd - 2] & 0xdf) === 0x70 &&
        (centralDirectory[nameEnd - 1] & 0xdf) === 0x6b;
      if (isDotApk) return true;
    }

    offset += entrySize;
  }

  return false;
}

export function isApkBundle(filePath: string): boolean {
  const tail = readFileTail(filePath, EOCD_SEARCH_WINDOW);
  const eocdOffset = findEndOfCentralDirectory(tail);
  if (eocdOffset < 0) return false;

  const entryCount = tail.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = tail.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = tail.readUInt32LE(eocdOffset + 16);
  if (entryCount === 0 || centralDirectorySize === 0) return false;

  const centralDirectory = readFileAt(filePath, centralDirectoryOffset, centralDirectorySize);
  return centralDirectoryContainsApkEntry(centralDirectory, entryCount);
}
