/**
 * Incremental log reader for the UI's log panel.
 *
 * The browser polls with the byte offset it last saw and gets only what was
 * appended since, so a multi-megabyte log costs one small read per poll. A
 * shrunken file means the logger rotated, so we start over from the top.
 */

import * as fs from 'fs';
import { logFilePath } from '../config';

/** Never hand back more than this in one poll. */
const MAX_CHUNK = 256 * 1024;
/** On a first read, show roughly this much history. */
const INITIAL_TAIL = 32 * 1024;

export interface LogChunk {
  /** Appended text. Empty when nothing changed. */
  text: string;
  /** Byte offset to send with the next poll. */
  offset: number;
  /** Current file size, for the UI's "log is N KB" hint. */
  size: number;
  /** True when the file was rotated or truncated since the last poll. */
  rotated: boolean;
  exists: boolean;
}

/**
 * Reads whatever was appended after `fromOffset`.
 * Pass a negative offset to start with the tail of the file.
 */
export function readLog(fromOffset: number): LogChunk {
  const filePath = logFilePath();

  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return { text: '', offset: 0, size: 0, rotated: false, exists: false };
  }

  // First poll: skip to the last INITIAL_TAIL bytes instead of the whole file.
  let start = fromOffset;
  let rotated = false;
  if (start < 0) {
    start = Math.max(0, size - INITIAL_TAIL);
  } else if (start > size) {
    // The file got smaller — rotation. Re-read from the beginning.
    start = 0;
    rotated = true;
  }

  if (start >= size) {
    return { text: '', offset: size, size, rotated, exists: true };
  }

  const length = Math.min(size - start, MAX_CHUNK);
  const buffer = Buffer.alloc(length);

  let fd: number | null = null;
  let read = 0;
  try {
    fd = fs.openSync(filePath, 'r');
    read = fs.readSync(fd, buffer, 0, length, start);
  } catch {
    return { text: '', offset: start, size, rotated, exists: true };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing useful to do */
      }
    }
  }

  let text = buffer.subarray(0, read).toString('utf-8');
  // A partial first line is noise when we jumped into the middle of the file.
  if (fromOffset < 0 && start > 0) {
    const firstBreak = text.indexOf('\n');
    if (firstBreak !== -1) text = text.slice(firstBreak + 1);
  }

  return { text, offset: start + read, size, rotated, exists: true };
}
