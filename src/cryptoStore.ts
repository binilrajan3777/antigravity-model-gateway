/**
 * API key storage for custom_models.json.
 *
 * ## This is obfuscation, not encryption
 *
 * Keys are stored base64-encoded behind a `fallback:` prefix. `fallback:c2stMTIzNA==`
 * decodes to `sk-1234` with one command. Anyone who can read the file can recover
 * every key in it — protect the file with filesystem permissions, or keep keys in
 * environment variables and out of the file entirely.
 *
 * The original Electron app encrypted via `safeStorage` (DPAPI on Windows, Keychain
 * on macOS, libsecret on Linux) and wrote an `enc:` prefix. This proxy is a plain
 * Node process with no access to those key stores, so `enc:` values cannot be read
 * back here — see decryptString().
 */

import * as fs from 'fs';

/** Written by this module. Base64, reversible by anyone. */
const FALLBACK_PREFIX = 'fallback:';
/** Written by the Electron app's safeStorage. Not readable from plain Node. */
const SAFE_STORAGE_PREFIX = 'enc:';

/**
 * Copies the file to `<name>.bak` before it is rewritten in place.
 */
export function backupFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      const backupPath = filePath + '.bak';
      fs.copyFileSync(filePath, backupPath);
      console.log(`[CryptoStore] Backup created successfully at: ${backupPath}`);
    }
  } catch (err) {
    console.error('[CryptoStore] Failed to create file backup:', err);
  }
}

/**
 * Base64-encodes a key behind the `fallback:` prefix. See the module note — this
 * hides the key from a casual glance and nothing more.
 */
export function encryptString(plainText: string): string {
  if (!plainText || plainText === 'none') return plainText;
  return FALLBACK_PREFIX + Buffer.from(plainText, 'utf-8').toString('base64');
}

/**
 * Reads back a stored key. Handles `fallback:`, `enc:` and bare plaintext.
 */
export function decryptString(encryptedText: string): string {
  if (!encryptedText || encryptedText === 'none') return encryptedText;

  if (encryptedText.startsWith(SAFE_STORAGE_PREFIX)) {
    // Written by the Electron app against an OS key store we cannot reach.
    console.error(
      '[CryptoStore] Key uses the Electron safeStorage "enc:" format, which this proxy ' +
        'cannot decrypt. Replace it with the plaintext key — it will be re-encoded on load.',
    );
    return 'DECRYPTION_FAILED_STORAGE_UNAVAILABLE';
  }

  if (encryptedText.startsWith(FALLBACK_PREFIX)) {
    const base64Data = encryptedText.substring(FALLBACK_PREFIX.length);
    try {
      return Buffer.from(base64Data, 'base64').toString('utf-8');
    } catch (err) {
      console.error('[CryptoStore] Fallback base64 decode failed:', err);
      return 'DECRYPTION_FAILED';
    }
  }

  // Plaintext, not yet migrated. loadCustomModels() re-encodes it on next write.
  return encryptedText;
}

/**
 * The only two fields these helpers touch. Generic over the rest so a caller's
 * richer model type survives the round trip — nothing is stripped, and callers
 * do not need a cast to get their own type back.
 */
export interface ModelWithKey {
  apiKey?: string;
  encrypted?: boolean;
}

/**
 * Encodes every unencoded API key in the list. All other fields are preserved.
 */
export function encryptModels<T extends ModelWithKey>(models: T[] | null): T[] {
  if (!models || !Array.isArray(models)) return [];
  return models.map((model) => {
    if (model.apiKey && model.apiKey !== 'none' && !model.encrypted) {
      return {
        ...model,
        apiKey: encryptString(model.apiKey),
        encrypted: true,
      };
    }
    return model;
  });
}

/**
 * Decodes API keys for in-memory use. All other fields are preserved.
 */
export function decryptModels<T extends ModelWithKey>(models: T[] | null): T[] {
  if (!models || !Array.isArray(models)) return [];
  return models.map((model) => {
    if (model.encrypted) {
      return {
        ...model,
        apiKey: decryptString(model.apiKey as string),
        encrypted: false,
      };
    }
    return model;
  });
}
