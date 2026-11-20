
import path from "node:path";

export interface TorrentStorageFile {
  path: string;
  length: number;
  offset?: number;
}

export function sanitizeTorrentFolderName(name: string): string {
  let result = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();

  if (!result || result === "." || result === "..") {
    result = "Untitled";
  }

  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(result)) {
    result = `_${result}`;
  }

  return result.slice(0, 120);
}

function sanitizePathSegment(segment: string): string {
  let result = segment
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();

  if (!result || result === "." || result === "..") {
    throw new Error(`Unsafe torrent file path segment: ${segment}`);
  }

  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(result)) {
    result = `_${result}`;
  }

  return result.slice(0, 120);
}

export function mapTorrentStorageFiles(
  torrentName: string,
  files: readonly TorrentStorageFile[],
): TorrentStorageFile[] {
  const folder = sanitizeTorrentFolderName(torrentName);

  const normalized = files.map((file) => ({
    ...file,
    path: file.path.replace(/\\/g, "/"),
  }));

  const firstRoot = normalized[0]?.path.split("/")[0];

  const hasSharedRoot =
    normalized.length > 0 &&
    normalized.every((file) => {
      const parts = file.path.split("/");
      return parts.length > 1 && parts[0] === firstRoot;
    });

  return normalized.map((file) => {
    const parts = file.path.split("/");
    const relativeParts = hasSharedRoot ? parts.slice(1) : parts;

    if (relativeParts.length === 0) {
      throw new Error(`Unsafe torrent file path: ${file.path}`);
    }

    const safeParts = relativeParts.map(sanitizePathSegment);

    return {
      ...file,
      path: path.posix.join(folder, ...safeParts),
    };
  });
}
