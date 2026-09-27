import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const EOCD_RECORD_SIZE = 22;
const CENTRAL_DIRECTORY_HEADER_SIZE = 46;
const EOCD_SEARCH_WINDOW = 65535 + 100; // max ZIP comment length, plus room for the EOCD record itself

// Raw little-endian bytes of the EOCD signature (0x06054b50).
const EOCD_SIGNATURE_BYTES = Buffer.from([0x50, 0x4b, 0x05, 0x06]);

// Single 32-bit word compare for ".apk"/".APK"/".Apk" etc.
const APK_EXTENSION_OR_MASK = 0x20202000; // lower-cases the 3 letter bytes, leaves the leading '.' untouched
const APK_EXTENSION_VALUE = 0x2e | (0x61 << 8) | (0x70 << 16) | (0x6b << 24); // '.apk'

function findEndOfCentralDirectory(tail: Buffer): number {
  if (tail.length < EOCD_RECORD_SIZE) return -1;
  return tail.lastIndexOf(EOCD_SIGNATURE_BYTES, tail.length - EOCD_RECORD_SIZE);
}

function endsWithApkExtension(buffer: Buffer, nameEnd: number): boolean {
  return (buffer.readUInt32LE(nameEnd - 4) | APK_EXTENSION_OR_MASK) === APK_EXTENSION_VALUE;
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
      if (endsWithApkExtension(centralDirectory, nameEnd)) return true;
    }

    offset += entrySize;
  }

  return false;
}

export function isApkBundle(filePath: string): boolean {
  const fd = openSync(filePath, 'r');
  try {
    const { size: fileSize } = fstatSync(fd);
    const tailSize = Math.min(fileSize, EOCD_SEARCH_WINDOW);
    const tail = Buffer.allocUnsafe(tailSize);
    readSync(fd, tail, 0, tailSize, fileSize - tailSize);

    const eocdOffset = findEndOfCentralDirectory(tail);
    if (eocdOffset < 0) return false;

    const entryCount = tail.readUInt16LE(eocdOffset + 10);
    const centralDirectorySize = tail.readUInt32LE(eocdOffset + 12);
    const centralDirectoryOffset = tail.readUInt32LE(eocdOffset + 16);
    if (entryCount === 0 || centralDirectorySize === 0) return false;

    const centralDirectory = Buffer.allocUnsafe(centralDirectorySize);
    readSync(fd, centralDirectory, 0, centralDirectorySize, centralDirectoryOffset);

    return centralDirectoryContainsApkEntry(centralDirectory, entryCount);
  } finally {
    closeSync(fd);
  }
}
