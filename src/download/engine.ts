
import WebTorrent, { type Torrent } from "webtorrent";
import FSChunkStore, {
  type ChunkStoreOptions,
} from "fs-chunk-store";
import { mapTorrentStorageFiles } from "./storage-path";
import {
  clearBindAddress,
  interfaceNames,
  setBindAddress,
  utpBindable,
  type InterfaceTable,
} from "../util/bind";
import {
  networkFromEnv,
  startInterfaceGuard,
  type NetworkOptions,
  type NetworkStatus,
} from "./network";

export interface TorrentProgress {
  progress: number;
  downloaded: number;
  total: number;
  speed: number;
  uploadSpeed: number;
  uploaded: number;
  peers: number;
  timeRemaining: number;
  name: string;
}

export interface TorrentMeta {
  name: string;
  total: number;
  files: number;
  torrentFile?: Uint8Array;
}

export interface AddHandlers {
  onMetadata?: (meta: TorrentMeta) => void;
  onReady?: () => void;
  onDone?: () => void;
  onError?: (message: string) => void;
}

export interface EngineOptions extends NetworkOptions {
  onNetwork?: (status: NetworkStatus) => void;
  interfaces?: () => InterfaceTable;
  guardIntervalMs?: number;
}

export interface NetworkPatch {
  interface?: string | null;
  peerPort?: number | null;
  dhtPort?: number | null;
}

export type ReconfigureResult =
  | { ok: true; status: NetworkStatus }
  | { ok: false; error: string };

export type TorrentSource = string | (() => string);

interface Registration {
  source: TorrentSource;
  dir: string;
  handlers: AddHandlers;
  announce?: string[];
  storageLayout?: "movie-folder";
  filePaths?: string[];
}

const TEARDOWN_WAIT_MS = 3000;

export const RESUME_SETTLE_MS = 3000;

export function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function applyNetworkPatch(
  current: NetworkOptions,
  patch: NetworkPatch,
): NetworkOptions {
  const next: NetworkOptions = { ...current };

  if (patch.interface !== undefined) {
    if (patch.interface === null) delete next.interface;
    else next.interface = patch.interface;
  }

  if (patch.peerPort !== undefined) {
    if (patch.peerPort === null) delete next.peerPort;
    else next.peerPort = patch.peerPort;
  }

  if (patch.dhtPort !== undefined) {
    if (patch.dhtPort === null) delete next.dhtPort;
    else next.dhtPort = patch.dhtPort;
  }

  return next;
}

export class TorrentEngine {
  private client: WebTorrent | null = null;
  private torrents = new Map<string, Torrent>();
  private registry = new Map<string, Registration>();
  private net: NetworkOptions;
  private readonly onNetwork:
    | ((status: NetworkStatus) => void)
    | undefined;
  private readonly interfaces:
    | (() => InterfaceTable)
    | undefined;
  private readonly guardIntervalMs: number | undefined;
  private online = true;
  private address: string | null = null;
  private known: string[] | undefined;
  private stopGuard: (() => void) | null = null;
  private teardown: Promise<void> = Promise.resolve();
  private pendingTeardowns = 0;
  private rebuilding = false;
  private generation = 0;
  private wasDown = false;
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastError: string | null = null;

  constructor(opts: EngineOptions = {}) {
    const { onNetwork, interfaces, guardIntervalMs, ...net } = opts;

    this.onNetwork = onNetwork;
    this.interfaces = interfaces;
    this.guardIntervalMs = guardIntervalMs;
    this.net = applyNetworkPatch(networkFromEnv(), net);

    this.applyNetwork();
  }

  private applyNetwork(): void {
    this.stopGuard?.();
    this.stopGuard = null;
    this.clearResume();
    this.wasDown = false;
    this.known = undefined;

    const spec = this.net.interface;

    if (!spec) {
      clearBindAddress();
      this.address = null;
      this.online = true;
      return;
    }

    this.online = false;
    setBindAddress(null);

    this.stopGuard = startInterfaceGuard(
      spec,
      (address, table) => this.onInterface(address, table),
      {
        ...(this.guardIntervalMs !== undefined
          ? { intervalMs: this.guardIntervalMs }
          : {}),
        ...(this.interfaces ? { table: this.interfaces } : {}),
      },
    );
  }

  private onInterface(
    address: string | null,
    table: InterfaceTable,
  ): void {
    if (address === null) {
      this.clearResume();
      this.wasDown = true;
      this.online = false;
      this.address = null;
      this.known = interfaceNames(table);
      setBindAddress(null);
      this.report();
      this.teardownClient();
      return;
    }

    this.online = true;
    this.address = address;
    this.known = undefined;
    setBindAddress(address);
    this.report();

    if (!this.wasDown) {
      this.rebuild();
      return;
    }

    this.rebuilding = true;

    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      this.rebuild();
    }, RESUME_SETTLE_MS);

    this.resumeTimer.unref();
  }

  private clearResume(): void {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
  }

  private report(): void {
    this.onNetwork?.(this.networkStatus());
  }

  private teardownClient(): void {
    const client = this.client;
    this.client = null;

    for (const t of this.torrents.values()) {
      try {
        t.destroy();
      } catch {}
    }

    this.torrents.clear();

    if (!client) return;

    this.pendingTeardowns++;

    const released = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, TEARDOWN_WAIT_MS);
      timer.unref();

      try {
        client.destroy(() => {
          clearTimeout(timer);
          resolve();
        });
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });

    this.teardown = Promise.all([
      this.teardown,
      released.then(() => void this.pendingTeardowns--),
    ]).then(() => {});
  }

  private rebuild(): void {
    if (this.pendingTeardowns === 0) {
      this.rebuilding = false;
      this.attachAll();
      return;
    }

    const gen = ++this.generation;
    this.rebuilding = true;

    void this.teardown.then(() => {
      if (gen !== this.generation) return;

      this.rebuilding = false;
      this.attachAll();
    });
  }

  private attachAll(): void {
    if (!this.online) return;

    this.wasDown = false;
    this.lastError = null;

    for (const [id, reg] of this.registry) {
      this.attach(id, reg);
    }
  }

  private ensureClient(): WebTorrent {
    if (!this.client) {
      const bound = this.net.interface !== undefined;

      const opts = {
        secure: 0 as const,
        ...(this.net.peerPort
          ? { torrentPort: this.net.peerPort }
          : {}),
        ...(this.net.dhtPort
          ? { dhtPort: this.net.dhtPort }
          : {}),
        ...(bound
          ? {
              lsd: false,
              natUpnp: false,
              natPmp: false,
              tracker: { wrtc: false },
              ...(utpBindable() ? {} : { utp: false }),
            }
          : {}),
        ...(process.env.TORLINK_NO_UTP
          ? { utp: false }
          : {}),
        ...(process.platform === "darwin"
          ? { natPmp: false }
          : {}),
      };

      const client = new WebTorrent(opts);

      client.on("error", (err: unknown) => {
        if (this.client !== client) return;

        this.lastError = message(err);

        if (client.destroyed) {
          this.client = null;
          this.torrents.clear();
        }

        this.report();
      });

      client.once("listening", () => {
        if (this.client === client) this.report();
      });

      this.client = client;
    }

    return this.client;
  }

  add(
    id: string,
    source: TorrentSource,
    dir: string,
    handlers: AddHandlers,
    announce?: string[],
    storageLayout?: "movie-folder",
  ): void {
    const reg: Registration = {
      source,
      dir,
      handlers,
      ...(announce && announce.length > 0 ? { announce } : {}),
      ...(storageLayout ? { storageLayout } : {}),
    };

    this.registry.set(id, reg);

    if (!this.online || this.rebuilding) return;

    try {
      this.ensureClient();
    } catch (e) {
      this.registry.delete(id);
      throw e;
    }

    this.attach(id, reg);
  }

  private attach(id: string, reg: Registration): void {
    const existing = this.torrents.get(id);

    if (existing) {
      this.torrents.delete(id);

      try {
        existing.destroy();
      } catch {}
    }

    let torrent: Torrent;

    try {
      const client = this.ensureClient();

      const source =
        typeof reg.source === "function"
          ? reg.source()
          : reg.source;

      const opts = {
        path: reg.dir,
        ...(reg.announce ? { announce: reg.announce } : {}),
        ...(reg.storageLayout === "movie-folder"
          ? {
              store: class MovieStorage extends FSChunkStore {
                constructor(
                  chunkLength: number,
                  storeOpts: ChunkStoreOptions = {},
                ) {
                  const torrentName = storeOpts.torrent?.name || id;
                  const originalFiles = storeOpts.files ?? [];

                  const mappedFiles = mapTorrentStorageFiles(
                    torrentName,
                    originalFiles,
                  );

                  reg.filePaths = mappedFiles.map((file) => file.path);

                  super(chunkLength, {
                    ...storeOpts,
                    files: mappedFiles,
                  });
                }
              },
            }
          : {}),
      };

      torrent = client.add(source, opts);
    } catch (e) {
      this.registry.delete(id);
      reg.handlers.onError?.(message(e));
      return;
    }

    this.torrents.set(id, torrent);

    const handlers = reg.handlers;

    torrent.on("metadata", () => {
      handlers.onMetadata?.({
        name: torrent.name,
        total: torrent.length,
        files: torrent.files?.length ?? 0,
        torrentFile: torrent.torrentFile,
      });
    });

    torrent.on("ready", () => {
      handlers.onReady?.();
    });

    torrent.on("done", () => {
      handlers.onDone?.();
    });

    torrent.on("error", (err: unknown) => {
      handlers.onError?.(message(err));

      if (this.registry.get(id) === reg) {
        this.registry.delete(id);
      }

      if (this.torrents.get(id) === torrent) {
        this.torrents.delete(id);
      }

      try {
        torrent.destroy();
      } catch {}
    });
  }

  listenPort(): number | null {
    return this.client?.torrentPort ?? null;
  }

  networkStatus(): NetworkStatus {
    const client = this.client;
    let incoming = 0;

    for (const t of this.torrents.values()) {
      try {
        for (const w of t.wires ?? []) {
          if (
            typeof w.type === "string" &&
            w.type.includes("Incoming")
          ) {
            incoming++;
          }
        }
      } catch {}
    }

    return {
      interface: this.net.interface ?? null,
      address: this.address,
      online: this.online,
      peerPort: client?.listening ? client.torrentPort : null,
      incoming,
      ...(this.known ? { known: this.known } : {}),
      ...(this.lastError !== null
        ? { error: this.lastError }
        : {}),
    };
  }

  reconfigure(patch: NetworkPatch): ReconfigureResult {
    const next = applyNetworkPatch(this.net, patch);

    if (
      next.peerPort !== undefined &&
      next.peerPort === next.dhtPort
    ) {
      return {
        ok: false,
        error: "dhtPort must differ from peerPort",
      };
    }

    this.net = next;
    this.teardownClient();
    this.applyNetwork();

    if (!this.net.interface) this.rebuild();

    return {
      ok: true,
      status: this.networkStatus(),
    };
  }

  filePaths(id: string): string[] {
    const torrent = this.torrents.get(id);

    if (!torrent) return [];

    const registration = this.registry.get(id);

    return (
      registration?.filePaths ??
      (torrent.files ?? []).map((file) => file.path)
    );
  }

  stats(id: string): TorrentProgress | null {
    const t = this.torrents.get(id);

    if (!t) return null;

    let progress = 0;
    let downloaded = 0;
    let total = 0;
    let speed = 0;
    let uploadSpeed = 0;
    let uploaded = 0;
    let peers = 0;
    let timeRemaining = Infinity;
    let name = "";

    try {
      progress = t.progress || 0;
      downloaded = t.downloaded || 0;
      total = t.length || 0;
      speed = t.downloadSpeed || 0;
      uploadSpeed = t.uploadSpeed || 0;
      uploaded = t.uploaded || 0;
      peers = t.numPeers || 0;

      timeRemaining =
        typeof t.timeRemaining === "number" &&
        !isNaN(t.timeRemaining)
          ? t.timeRemaining
          : Infinity;

      name = t.name || "";
    } catch {}

    return {
      progress,
      downloaded,
      total,
      speed,
      uploadSpeed,
      uploaded,
      peers,
      timeRemaining,
      name,
    };
  }

  remove(id: string): void {
    this.registry.delete(id);

    const t = this.torrents.get(id);
    this.torrents.delete(id);

    if (t) {
      try {
        t.destroy();
      } catch {}
    }
  }

  destroy(): void {
    this.generation++;
    this.stopGuard?.();
    this.stopGuard = null;
    this.clearResume();
    this.registry.clear();
    this.torrents.clear();

    const client = this.client;
    this.client = null;

    if (client) {
      setImmediate(() => {
        try {
          client.destroy();
        } catch {}
      });
    }
  }
}
