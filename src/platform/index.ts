export const MAX_WEB_ASM_BYTES = 5 * 1024 * 1024; // 5 MB
const STORAGE_KEY_DRAFT = 'emu8086-draft-code-v1';
const STORAGE_KEY_STRICT = 'emu8086-strict-mode';
const STORAGE_KEY_LOCALE = 'emu8086-locale';

export function isElectron(): boolean {
  return typeof window !== 'undefined' && Boolean(window.electronAPI);
}

export function isMacElectron(): boolean {
  return isElectron() && window.electronAPI?.platform === 'darwin';
}

export function isMacOS(): boolean {
  if (isMacElectron()) return true;
  if (typeof navigator !== 'undefined') {
    const plat = navigator.platform || navigator.userAgent || '';
    return /Mac|iPhone|iPad|iPod/i.test(plat);
  }
  return false;
}

export function getModKeySymbol(): string {
  return isMacOS() ? '⌘' : 'Ctrl+';
}

/**
 * Encodes assembly source code into a URL-safe Base64 share hash (`#code=...`).
 * Pure client-side, zero server dependency.
 */
export function encodeCodeToShareHash(code: string): string {
  const bytes = new TextEncoder().encode(code);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const b64 =
    typeof btoa === 'function'
      ? btoa(binary)
      : Buffer.from(bytes).toString('base64');
  const urlSafe = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `#code=${urlSafe}`;
}

/**
 * Decodes assembly source code from a `#code=...` URL hash.
 * Returns null if the hash is missing, invalid, or exceeds the 5 MB limit.
 */
export function decodeCodeFromShareHash(hash: string): string | null {
  if (!hash) return null;
  const cleaned = hash.startsWith('#') ? hash.slice(1) : hash;
  const match = cleaned.match(/(?:^|&)code=([A-Za-z0-9\-_]+)/);
  if (!match) return null;

  try {
    let b64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) {
      b64 += '=';
    }
    let bytes: Uint8Array;
    if (typeof atob === 'function') {
      const binary = atob(b64);
      if (binary.length > MAX_WEB_ASM_BYTES) return null;
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
    } else {
      const buf = Buffer.from(b64, 'base64');
      if (buf.byteLength > MAX_WEB_ASM_BYTES) return null;
      bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    }
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    if (text.includes('\0')) return null;
    return text;
  } catch {
    return null;
  }
}

/**
 * Validates and reads a dropped or picked browser File with a 5 MB size guard and binary check.
 */
export async function readWebAsmFileSafe(file: File): Promise<{
  ok: boolean;
  content?: string;
  errorTr?: string;
  errorEn?: string;
}> {
  if (file.size > MAX_WEB_ASM_BYTES) {
    return {
      ok: false,
      errorTr: 'Dosya boyutu çok büyük (maksimum 5 MB).',
      errorEn: 'File is too large (maximum 5 MB).',
    };
  }
  try {
    const content = await file.text();
    if (content.includes('\0')) {
      return {
        ok: false,
        errorTr: 'İkili (binary) dosya açılamaz; lütfen metin tabanlı bir .asm dosyası seçin.',
        errorEn: 'Binary files cannot be opened; please select a text-based .asm file.',
      };
    }
    return { ok: true, content };
  } catch (err) {
    return {
      ok: false,
      errorTr: `Dosya okunamadı: ${String(err)}`,
      errorEn: `Failed to read file: ${String(err)}`,
    };
  }
}

export function saveDraftCode(code: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY_DRAFT, code);
  } catch {
    // ignore storage quota errors
  }
}

export function loadDraftCode(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY_DRAFT);
  } catch {
    return null;
  }
}

export function clearDraftCode(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY_DRAFT);
  } catch {
    // ignore
  }
}

export function loadInitialStrictMode(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY_STRICT) === 'true';
  } catch {
    return false;
  }
}

export function saveStrictMode(strict: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY_STRICT, strict ? 'true' : 'false');
  } catch {
    // ignore
  }
}

export function loadSavedLocale(): 'tr' | 'en' | null {
  try {
    const val = window.localStorage.getItem(STORAGE_KEY_LOCALE);
    if (val === 'tr' || val === 'en') return val;
  } catch {
    // ignore
  }
  return null;
}

export function saveLocalePreference(locale: 'tr' | 'en'): void {
  try {
    window.localStorage.setItem(STORAGE_KEY_LOCALE, locale);
  } catch {
    // ignore
  }
}
