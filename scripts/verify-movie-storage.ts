
import WebTorrent, { type Torrent } from "webtorrent";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TorrentEngine } from "../src/download/engine";

const MOVIE_NAME = "Movie Storage Integration (2026)";
const TIMEOUT = 30_000;

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function makeBytes(size: number, seed: number): Buffer {
  const buffer = Buffer.allocUnsafe(size);

  for (let i = 0; i < size; i++) {
    buffer[i] = (i * 31 + seed) & 0xff;
  }

  return buffer;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  condition: () => boolean,
  timeout: number,
  label: string,
): Promise<void> {
  const start = Date.now();

  while (!condition()) {
    if (Date.now() - start > timeout) {
      throw new Error(`Timed out waiting for ${label}`);
    }

    await wait(200);
  }
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "shinobu-movie-storage-"),
  );

  const sourceRoot = path.join(root, "source");
  const seedDir = path.join(sourceRoot, MOVIE_NAME);
  const downloadDir = path.join(root, "downloads");

  const movieRelativePath = "video/movie.mkv";
  const subtitleRelativePath = "subtitles/en.srt";

  const movieBytes = makeBytes(3 * 1024 * 1024, 7);
  const subtitleBytes = Buffer.from(
    "1\n00:00:01,000 --> 00:00:04,000\nStorage integration test\n",
  );

  const moviePath = path.join(seedDir, movieRelativePath);
  const subtitlePath = path.join(seedDir, subtitleRelativePath);

  await fs.mkdir(path.dirname(moviePath), { recursive: true });
  await fs.mkdir(path.dirname(subtitlePath), { recursive: true });
  await fs.mkdir(downloadDir, { recursive: true });

  await fs.writeFile(moviePath, movieBytes);
  await fs.writeFile(subtitlePath, subtitleBytes);

  log(`Test movie: ${MOVIE_NAME}`);
  log("Created two local test files.");

  const minter = new WebTorrent({
    dht: false,
    tracker: false,
    lsd: false,
    secure: 0,
  });

  let metadata: Uint8Array;
  let infoHash: string;

  try {
    const minted = await new Promise<{
      meta: Uint8Array;
      infoHash: string;
    }>((resolve, reject) => {
      minter.seed(seedDir, { announce: [] }, (torrent) => {
        resolve({
          meta: Uint8Array.from(torrent.torrentFile),
          infoHash: torrent.infoHash,
        });
      });

      minter.once("error", reject);
    });

    metadata = minted.meta;
    infoHash = minted.infoHash;
  } finally {
    await new Promise<void>((resolve) =>
      minter.destroy(() => resolve()),
    );
  }

  const torrentPath = path.join(root, "movie.torrent");
  await fs.writeFile(torrentPath, metadata);

  log(`Torrent metadata created: ${infoHash}`);

  const seedClient = new WebTorrent({
    dht: false,
    tracker: false,
    lsd: false,
    secure: 0,
  });

  const engine = new TorrentEngine();

  let failures = 0;
  let targetTorrent: Torrent | undefined;
  let rewire: ReturnType<typeof setInterval> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const check = (
    label: string,
    passed: boolean,
    detail: string,
  ): void => {
    log(`${passed ? "PASS" : "FAIL"}  ${label}  ${detail}`);

    if (!passed) failures++;
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const torrent = seedClient.add(torrentPath, {
        path: sourceRoot,
        announce: [],
      });

      torrent.once("ready", resolve);
      torrent.once("error", reject);
    });

    await waitUntil(
      () => seedClient.listening && seedClient.torrentPort > 0,
      10_000,
      "local seeder port",
    );

    const sourcePort = seedClient.torrentPort;

    log(`Local seeder ready on port ${sourcePort}`);

    const engineTorrentMap = (
      engine as unknown as {
        torrents: Map<string, Torrent>;
      }
    ).torrents;

    let downloadError: string | null = null;
    let completed = false;

    engine.add(
      infoHash,
      torrentPath,
      downloadDir,
      {
        onMetadata: (metadata) => {
          log(
            `Download metadata: ${metadata.name}, ${metadata.files} files`,
          );
        },
        onReady: () => log("Download engine ready."),
        onDone: () => {
          completed = true;
        },
        onError: (message) => {
          downloadError = message;
          log(`Download error: ${message}`);
        },
      },
      [],
      "movie-folder",
    );

    await waitUntil(
      () => engineTorrentMap.has(infoHash),
      10_000,
      "download torrent attachment",
    );

    targetTorrent = engineTorrentMap.get(infoHash);

    if (!targetTorrent) {
      throw new Error("Download torrent was not attached.");
    }

    await waitUntil(
      () => Boolean(targetTorrent?.infoHash),
      10_000,
      "download torrent info hash",
    );

    log("Download info hash ready. Connecting to local seeder.");

    const connectPeer = (): void => {
      if (!targetTorrent?.infoHash) return;

      targetTorrent.addPeer(`[::1]:${sourcePort}`);
      targetTorrent.addPeer(`127.0.0.1:${sourcePort}`);
    };

    connectPeer();
    rewire = setInterval(connectPeer, 500);

    timeout = setTimeout(() => {
      if (!completed) {
        downloadError = "Download timed out.";
      }
    }, TIMEOUT);

    await waitUntil(
      () => completed || downloadError !== null,
      TIMEOUT + 2_000,
      "movie download completion",
    );

    clearTimeout(timeout);
    timeout = undefined;

    if (rewire) {
      clearInterval(rewire);
      rewire = undefined;
    }

    if (downloadError) {
      throw new Error(downloadError);
    }

    const expectedMoviePath = path.join(
      downloadDir,
      MOVIE_NAME,
      movieRelativePath,
    );

    const expectedSubtitlePath = path.join(
      downloadDir,
      MOVIE_NAME,
      subtitleRelativePath,
    );

    const actualMovie = await fs.readFile(expectedMoviePath);
    const actualSubtitle = await fs.readFile(expectedSubtitlePath);

    check(
      "movie file created inside movie folder",
      actualMovie.equals(movieBytes),
      expectedMoviePath,
    );

    check(
      "subtitle file created inside movie folder",
      actualSubtitle.equals(subtitleBytes),
      expectedSubtitlePath,
    );

    const mappedPaths = engine.filePaths(infoHash);

    check(
      "engine reports movie-folder paths",
      mappedPaths.some((p) => p.includes(MOVIE_NAME)),
      JSON.stringify(mappedPaths),
    );

    const movieRootEntries = await fs.readdir(
      path.join(downloadDir, MOVIE_NAME),
    );

    check(
      "movie folder contains expected directories",
      movieRootEntries.includes("video") &&
        movieRootEntries.includes("subtitles"),
      JSON.stringify(movieRootEntries),
    );
  } finally {
    if (timeout) clearTimeout(timeout);
    if (rewire) clearInterval(rewire);

    engine.destroy();

    await new Promise<void>((resolve) =>
      seedClient.destroy(() => resolve()),
    );

    await wait(500);

    await fs.rm(root, {
      recursive: true,
      force: true,
    }).catch(() => {});
  }

  log("");
  log(
    failures === 0
      ? "RESULT: MOVIE STORAGE VERIFIED"
      : `RESULT: ${failures} CHECK(S) FAILED`,
  );

  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  log(
    `HARNESS ERROR: ${
      error instanceof Error ? error.stack : String(error)
    }`,
  );

  process.exitCode = 1;
});
