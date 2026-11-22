import path from 'path';

export const MAX_ASM_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_DOCX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB

const LOCAL_DEV_URL_REGEX = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i;
const ALLOWED_EXTERNAL_URLS = new Set<string>([
  'https://github.com/CelalTurkoglu/Emu8086_for_Mac',
  'https://github.com/CelalTurkoglu/Emu8086_for_Mac/releases',
  'https://github.com/CelalTurkoglu/Emu8086_for_Mac#readme',
]);

/**
 * Normalizes a filesystem path into a canonical absolute path.
 * Rejects empty strings or strings containing NUL bytes.
 */
export function normalizeLocalPath(rawPath: unknown): string | null {
  if (typeof rawPath !== 'string') return null;
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes('\0')) return null;
  return path.resolve(trimmed);
}

/**
 * Validates whether a development server URL is safe to load in unpackaged mode.
 */
export function isAllowedDevServerUrl(
  url: unknown,
  isPackaged: boolean
): url is string {
  if (isPackaged) return false;
  if (typeof url !== 'string') return false;
  return LOCAL_DEV_URL_REGEX.test(url.trim());
}

/**
 * Validates whether an IPC sender frame URL is trusted (our own local app or dev server).
 */
export function isTrustedIpcSenderUrl(
  senderUrl: unknown,
  isPackaged: boolean,
  expectedDistIndexPath?: string
): boolean {
  if (typeof senderUrl !== 'string' || !senderUrl) return false;
  if (!isPackaged && LOCAL_DEV_URL_REGEX.test(senderUrl)) {
    return true;
  }
  if (!senderUrl.startsWith('file://')) return false;

  if (expectedDistIndexPath) {
    try {
      const parsed = new URL(senderUrl);
      const decodedPath = decodeURIComponent(parsed.pathname);
      const normalizedSender = path.resolve(
        process.platform === 'win32' && decodedPath.startsWith('/')
          ? decodedPath.slice(1)
          : decodedPath
      );
      const normalizedExpected = path.resolve(expectedDistIndexPath);
      return normalizedSender === normalizedExpected;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Checks whether an in-window navigation target should be permitted.
 * Blocks all external URLs and arbitrary dropped local files.
 */
export function isAllowedNavigationUrl(
  targetUrl: unknown,
  isPackaged: boolean,
  expectedDistIndexPath?: string
): boolean {
  return isTrustedIpcSenderUrl(targetUrl, isPackaged, expectedDistIndexPath);
}

/**
 * Validates whether a path can be overwritten directly without showing a Save dialog.
 */
export function canDirectSaveAsmPath(
  filePath: unknown,
  allowedAsmPaths: ReadonlySet<string>
): string | null {
  const normalized = normalizeLocalPath(filePath);
  if (!normalized) return null;
  return allowedAsmPaths.has(normalized) ? normalized : null;
}

/**
 * Validates whether a path is allowed to be opened via shell.openPath.
 * Strictly restricted to .docx files exported during the current session.
 */
export function canOpenSavedDocxPath(
  filePath: unknown,
  allowedDocxPaths: ReadonlySet<string>
): string | null {
  const normalized = normalizeLocalPath(filePath);
  if (!normalized) return null;
  if (!normalized.toLowerCase().endsWith('.docx')) return null;
  return allowedDocxPaths.has(normalized) ? normalized : null;
}

/**
 * Validates whether a path is allowed to be revealed in Finder / Explorer.
 */
export function canRevealSavedPath(
  filePath: unknown,
  allowedAsmPaths: ReadonlySet<string>,
  allowedDocxPaths: ReadonlySet<string>
): string | null {
  const normalized = normalizeLocalPath(filePath);
  if (!normalized) return null;
  if (allowedAsmPaths.has(normalized) || allowedDocxPaths.has(normalized)) {
    return normalized;
  }
  return null;
}

/**
 * Checks whether an external documentation URL is on the strict allowlist.
 */
export function isAllowedExternalUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  return ALLOWED_EXTERNAL_URLS.has(url.trim());
}
