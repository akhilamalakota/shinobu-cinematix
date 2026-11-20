
import { EventEmitter } from "node:events";
import { TorrentEngine, message, type AddHandlers, type NetworkPatch, type ReconfigureResult } from "./engine";
import type { NetworkStatus } from "./network";
import {
  saveQueue,
  saveQueueSync,
  saveSeeds,
  saveSeedsSync,
  saveTorrentMeta,
  torrentMetaPath,
  torrentMetaExists,
  exportTorrentMeta,
  deleteTorrentMeta,
  type SeedRecord,
} from "./persist";
import { saveHistory, saveHistorySync, type HistoryItem } from "./history";
import { deleteSeedData } from "./delete-data";
import { writePlaylists } from "./playlist";
import { disarmBootMarker } from "./bootguard";
import { trackersOf } from "../sources/magnet";
import type { QueueItem, SeedItem } from "./types";
import type { SourceId } from "../sources/types";

export function strayDownload(s: { total: number; progress: number; speed: number }): boolean {
  return s.total > 0 && s.progress < 1 && s.speed > 0;
}

const STRAY_TICKS = 2;
const SEED_GRACE_MS = 10_000;
const FETCH_METADATA_TIMEOUT_MS = 20_000;
const POLL_MS = 500;
const HISTORY_MAX = 500;

function readMaxDownloads(): number {
  const v = Number(process.env.TORLINK_MAX_DOWNLOADS);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

export interface AddInput {
  id: string;
  name: string;
  magnet: string;
  source?: SourceId;
  sizeBytes?: number;
  seedTimeMs?: number;
}

export interface RestoreOptions {
  safe?: boolean;
}

export class DownloadQueue extends EventEmitter {
  private items = new Map<string, QueueItem>();
  private engine: TorrentEngine;
  private poll: ReturnType<typeof setInterval> | null = null;
  private history: HistoryItem[] = [];
  private seeds = new Map<string, SeedItem>();
  private strayHits = new Map<string, number>();
  private seedStartedAt = new Map<string, number | null>();
  private trackers: string[] = [];

  private readonly maxDownloads: number;
  private readonly playlist: boolean;

  constructor(opts?: { maxDownloads?: number; playlist?: boolean }) {
    super();
    this.maxDownloads = opts?.maxDownloads ?? readMaxDownloads();
    this.playlist = opts?.playlist ?? !process.env.TORLINK_NO_PLAYLIST;
    this.engine = new TorrentEngine({ onNetwork: (status) => this.networkChanged(status) });
  }

  private networkChanged(status: NetworkStatus): void {
    if (!status.online) {
      this.zeroLiveStats();
      for (const sd of this.seeds.values()) {
        if (sd.status === "seeding") this.seedStartedAt.set(sd.id, null);
      }
      this.changed();
    }
    this.emit("network", status);
  }

  networkStatus(): NetworkStatus {
    return this.engine.networkStatus();
  }

  reconfigureNetwork(patch: NetworkPatch): ReconfigureResult {
    return this.engine.reconfigure(patch);
  }

  private zeroLiveStats(): void {
    for (const it of this.items.values()) {
      if (it.status === "downloading") {
        it.speed = 0;
        it.peers = 0;
        it.eta = undefined;
      }
    }
    for (const sd of this.seeds.values()) {
      if (sd.status === "seeding") {
        sd.uploadSpeed = 0;
        sd.peers = 0;
      }
    }
  }

  setTrackers(trackers: string[]): void {
    this.trackers = trackers;
  }

  getItems(): QueueItem[] {
    return [...this.items.values()].sort((a, b) => b.addedAt - a.addedAt);
  }

  get activeCount(): number {
    let n = 0;
    for (const it of this.items.values()) if (it.status === "downloading") n++;
    return n;
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  add(input: AddInput, dir: string): void {
    if (this.seeds.has(input.id)) {
      this.engine.remove(input.id);
      this.seeds.delete(input.id);
      this.strayHits.delete(input.id);
      this.seedStartedAt.delete(input.id);
      void this.persistSeeds();
    }

    const existing = this.items.get(input.id);
    if (existing && existing.status !== "failed") return;

    const item: QueueItem = existing
      ? {
          ...existing,
          dir,
          status: "downloading",
          error: undefined,
          speed: 0,
          ...(input.seedTimeMs !== undefined ? { seedTimeMs: input.seedTimeMs } : {}),
          ...(existing.dir === dir
            ? {}
            : { progress: 0, downloadedBytes: 0, eta: undefined }),
        }
      : {
          id: input.id,
          name: input.name,
          source: input.source,
          magnet: input.magnet,
          dir,
          storageLayout: "movie-folder",
          status: "downloading",
          progress: 0,
          totalBytes: input.sizeBytes ?? 0,
          downloadedBytes: 0,
          speed: 0,
          peers: 0,
          addedAt: Date.now(),
          ...(input.seedTimeMs !== undefined ? { seedTimeMs: input.seedTimeMs } : {}),
        };

    const start = this.maxDownloads === 0 || this.activeCount < this.maxDownloads;
    item.status = start ? "downloading" : "queued";
    this.items.set(item.id, item);

    if (start) {
      this.startEngine(item);
      this.ensurePoll();
    }

    this.changed();
    void this.persist();
  }

  private startEngine(item: QueueItem): void {
    try {
      const source = (): string =>
        torrentMetaExists(item.id) ? torrentMetaPath(item.id) : item.magnet;
      const announce = [...(trackersOf(item.magnet) ?? []), ...this.trackers];
      this.engine.add(
        item.id,
        source,
        item.dir,
        this.engineHandlers(item.id),
        announce,
        item.storageLayout,
      );
    } catch (e) {
      item.status = "failed";
      item.error = message(e);
      item.speed = 0;
      item.peers = 0;
    }
  }

  private promote(): void {
    const cap = this.maxDownloads === 0 ? Infinity : this.maxDownloads;
    let started = false;
    while (this.activeCount < cap) {
      const next = [...this.items.values()]
        .filter((it) => it.status === "queued")
        .sort((a, b) => a.addedAt - b.addedAt)[0];
      if (!next) break;
      next.status = "downloading";
      next.speed = 0;
      this.startEngine(next);
      started = true;
    }
    if (started) {
      this.ensurePoll();
      this.changed();
      void this.persist();
    }
  }

  private engineHandlers(id: string): AddHandlers {
    return {
      onMetadata: (meta) => {
        if (meta.torrentFile) void saveTorrentMeta(id, meta.torrentFile);
        const it = this.items.get(id);
        if (!it) return;
        if (meta.name) it.name = meta.name;
        if (meta.total) it.totalBytes = meta.total;
        it.files = meta.files;
        this.changed();
        void this.persist();
      },
      onReady: () => {
        if (this.seedStartedAt.get(id) === null) this.seedStartedAt.set(id, Date.now());
      },
      onDone: () => {
        const it = this.items.get(id);
        if (it) {
          if (it.totalBytes) it.downloadedBytes = it.totalBytes;
          this.complete(it);
          return;
        }
        if (this.seeds.has(id)) {
          this.strayHits.set(id, 0);
          this.seedStartedAt.delete(id);
        }
      },
      onError: (msg) => {
        const it = this.items.get(id);
        if (it) {
          it.status = "failed";
          it.error = msg;
          it.speed = 0;
          it.peers = 0;
          this.changed();
          void this.persist();
          this.promote();
          this.maybeStopPoll();
          return;
        }
        const sd = this.seeds.get(id);
        if (sd) {
          sd.status = "missing";
          sd.uploadSpeed = 0;
          sd.peers = 0;
          this.seedStartedAt.delete(id);
          this.changed();
          void this.persistSeeds();
          this.maybeStopPoll();
        }
      },
    };
  }

  private complete(it: QueueItem): void {
    this.recordHistory(it);
    this.items.delete(it.id);
    this.beginSeed(it);
    if (this.playlist) void writePlaylists(it.dir, this.engine.filePaths(it.id));
    this.emit("completed", it.name);
    this.changed();
    void this.persist();
    this.promote();
    this.maybeStopPoll();
  }

  private beginSeed(it: QueueItem): void {
    if (!it.magnet) return;
    this.seeds.set(it.id, {
      id: it.id,
      name: it.name,
      source: it.source,
      magnet: it.magnet,
      dir: it.dir,
      sizeBytes: it.totalBytes,
      status: "seeding",
      uploadSpeed: 0,
      uploaded: 0,
      peers: 0,
    });
    this.strayHits.set(it.id, 0);
    this.seedStartedAt.set(it.id, Date.now());
    this.ensurePoll();
    void this.persistSeeds();
  }

  private tick(): void {
    let any = false;
    for (const it of this.items.values()) {
      if (it.status !== "downloading") continue;
      const s = this.engine.stats(it.id);
      if (!s) continue;
      it.progress = Math.min(100, Math.round(s.progress * 100));
      it.downloadedBytes = s.downloaded;
      if (s.total) it.totalBytes = s.total;
      it.speed = s.speed;
      it.peers = s.peers;
      it.eta =
        s.timeRemaining > 0 && Number.isFinite(s.timeRemaining)
          ? s.timeRemaining / 1000
          : undefined;
      if (s.name) it.name = s.name;
      any = true;
    }
    const now = Date.now();
    for (const sd of this.seeds.values()) {
      if (sd.status !== "seeding") continue;
      const s = this.engine.stats(sd.id);
      if (!s) continue;
      const started = this.seedStartedAt.get(sd.id);
      const age = started === null ? 0 : now - (started ?? 0);
      if (age > SEED_GRACE_MS && strayDownload(s)) {
        const hits = (this.strayHits.get(sd.id) ?? 0) + 1;
        this.strayHits.set(sd.id, hits);
        if (hits >= STRAY_TICKS) {
          this.engine.remove(sd.id);
          this.strayHits.delete(sd.id);
          this.seedStartedAt.delete(sd.id);
          sd.status = "missing";
          sd.uploadSpeed = 0;
          sd.peers = 0;
          void this.persistSeeds();
        }
        any = true;
        continue;
      }
      this.strayHits.set(sd.id, 0);
      sd.uploadSpeed = s.uploadSpeed;
      sd.uploaded = s.uploaded;
      sd.peers = s.peers;
      any = true;
    }
    if (any) this.changed();
  }

  private ensurePoll(): void {
    if (this.poll) return;
    this.poll = setInterval(() => this.tick(), POLL_MS);
    this.poll.unref();
  }

  private maybeStopPoll(): void {
    if (this.activeCount === 0 && this.seedingCount === 0 && this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
  }

  pause(id: string): void {
    const it = this.items.get(id);
    if (!it || (it.status !== "downloading" && it.status !== "queued")) return;
    const wasDownloading = it.status === "downloading";
    it.status = "paused";
    it.speed = 0;
    it.peers = 0;
    it.eta = undefined;
    if (wasDownloading) this.engine.remove(id);
    this.changed();
    void this.persist();
    if (wasDownloading) {
      this.promote();
      this.maybeStopPoll();
    }
  }

  resume(id: string): void {
    const it = this.items.get(id);
    if (!it || it.status !== "paused") return;
    const start = this.maxDownloads === 0 || this.activeCount < this.maxDownloads;
    it.status = start ? "downloading" : "queued";
    if (start) {
      this.startEngine(it);
      this.ensurePoll();
    }
    this.changed();
    void this.persist();
  }

  togglePause(id: string): void {
    const it = this.items.get(id);
    if (!it) return;
    if (it.status === "downloading" || it.status === "queued") this.pause(id);
    else if (it.status === "paused") this.resume(id);
  }

  exportTorrentFile(id: string): Promise<string | null> {
    const it = this.items.get(id) ?? this.seeds.get(id) ?? this.history.find((h) => h.id === id);
    if (!it) return Promise.resolve(null);
    return exportTorrentMeta(it.id, it.name, it.dir);
  }

  fetchAndExportTorrent(
    input: { id: string; name: string; magnet: string },
    exportDir: string,
  ): Promise<string | null> {
    if (torrentMetaExists(input.id)) {
      return exportTorrentMeta(input.id, input.name, exportDir);
    }
    if (this.items.has(input.id) || this.seeds.has(input.id)) {
      return Promise.resolve(null);
    }
    return new Promise<string | null>((resolve) => {
      const tempKey = `__meta__${input.id}`;
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        this.engine.remove(tempKey);
        resolve(null);
      }, FETCH_METADATA_TIMEOUT_MS);
      this.engine.add(tempKey, input.magnet, exportDir, {
        onMetadata: (meta) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          this.engine.remove(tempKey);
          void (async () => {
            if (meta.torrentFile) await saveTorrentMeta(input.id, meta.torrentFile);
            resolve(await exportTorrentMeta(input.id, input.name, exportDir));
          })();
        },
        onError: () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          this.engine.remove(tempKey);
          resolve(null);
        },
      });
    });
  }

  cancel(id: string): void {
    if (!this.items.has(id)) return;
    this.engine.remove(id);
    this.items.delete(id);
    deleteTorrentMeta(id);
    this.changed();
    void this.persist();
    this.promote();
    this.maybeStopPoll();
  }

  async remove(id: string, opts: { deleteFiles?: boolean } = {}): Promise<boolean> {
    const it = this.items.get(id);
    const seed = this.seeds.get(id);
    const hist = this.history.find((h) => h.id === id);
    if (!it && !seed && !hist) return false;

    const dir = it?.dir ?? seed?.dir ?? hist?.dir;
    const name = it?.name ?? seed?.name ?? hist?.name;

    if (it || seed) this.engine.remove(id);
    if (it) this.items.delete(id);
    if (seed) {
      this.seeds.delete(id);
      this.strayHits.delete(id);
      this.seedStartedAt.delete(id);
    }
    deleteTorrentMeta(id);
    this.removeHistory(id);

    if (opts.deleteFiles && dir && name) {
      await deleteSeedData(dir, name);
    }

    this.changed();
    void this.persist();
    void this.persistSeeds();
    if (it) this.promote();
    this.maybeStopPoll();
    return true;
  }

  retry(id: string): void {
    const it = this.items.get(id);
    if (!it || it.status !== "failed") return;
    it.error = undefined;
    const start = this.maxDownloads === 0 || this.activeCount < this.maxDownloads;
    it.status = start ? "downloading" : "queued";
    if (start) {
      this.startEngine(it);
      this.ensurePoll();
    }
    this.changed();
    void this.persist();
  }

  retryFailed(): void {
    for (const it of [...this.items.values()]) {
      if (it.status === "failed") this.retry(it.id);
    }
  }

  getSeed(id: string): SeedItem | undefined {
    return this.seeds.get(id);
  }

  getSeeds(): SeedItem[] {
    return [...this.seeds.values()];
  }

  get seedingCount(): number {
    let n = 0;
    for (const s of this.seeds.values()) if (s.status === "seeding") n++;
    return n;
  }

  startSeeding(h: HistoryItem): void {
    if (this.seeds.get(h.id)?.status === "seeding") return;
    if (this.items.has(h.id)) return;

    const base: SeedItem = {
      id: h.id,
      name: h.name,
      source: h.source,
      magnet: h.magnet,
      dir: h.dir,
      sizeBytes: h.sizeBytes,
      status: "seeding",
      uploadSpeed: 0,
      uploaded: 0,
      peers: 0,
    };

    if (!h.magnet) {
      this.seeds.set(h.id, { ...base, status: "missing" });
      this.changed();
      void this.persistSeeds();
      return;
    }

    this.seeds.set(h.id, base);
    this.strayHits.set(h.id, 0);
    this.seedStartedAt.set(h.id, null);
    const source = (): string => (torrentMetaExists(h.id) ? torrentMetaPath(h.id) : h.magnet);
    try {
      this.engine.add(
        h.id,
        source,
        h.dir,
        this.engineHandlers(h.id),
        this.trackers,
        h.storageLayout,
      );
    } catch {
      this.seeds.set(h.id, { ...base, status: "paused" });
      this.changed();
      void this.persistSeeds();
      return;
    }
    this.ensurePoll();
    this.changed();
    void this.persistSeeds();
  }

  stopSeeding(id: string): void {
    const s = this.seeds.get(id);
    if (!s) return;
    this.engine.remove(id);
    this.strayHits.delete(id);
    this.seedStartedAt.delete(id);
    if (s.status === "seeding") {
      s.status = "paused";
      s.uploadSpeed = 0;
      s.peers = 0;
    }
    this.changed();
    void this.persistSeeds();
    this.maybeStopPoll();
  }

  toggleSeeding(h: HistoryItem): void {
    if (this.seeds.get(h.id)?.status === "seeding") this.stopSeeding(h.id);
    else this.startSeeding(h);
  }

  restoreSeeds(records: SeedRecord[], opts: RestoreOptions = {}): void {
    for (const r of records) {
      const h = this.history.find((x) => x.id === r.id);
      if (!h) continue;
      if (r.status === "seeding" && !opts.safe) this.startSeeding(h);
      else this.restorePaused(h);
    }
    if (opts.safe) void this.persistSeeds();
  }

  private restorePaused(h: HistoryItem): void {
    if (this.seeds.has(h.id)) return;
    this.seeds.set(h.id, {
      id: h.id,
      name: h.name,
      source: h.source,
      magnet: h.magnet,
      dir: h.dir,
      sizeBytes: h.sizeBytes,
      status: "paused",
      uploadSpeed: 0,
      uploaded: 0,
      peers: 0,
    });
    this.changed();
  }

  private seedRecords(): SeedRecord[] {
    const out: SeedRecord[] = [];
    for (const s of this.seeds.values()) {
      if (s.status === "seeding") out.push({ id: s.id, status: "seeding" });
      else out.push({ id: s.id, status: "paused" });
    }
    return out;
  }

  private persistSeeds(): Promise<void> {
    return saveSeeds(this.seedRecords()).catch(() => {});
  }

  restore(items: QueueItem[], opts: RestoreOptions = {}): void {
    if (opts.safe) {
      for (const raw of items) {
        if (raw.status === "downloading" || raw.status === "queued") raw.status = "paused";
        this.items.set(raw.id, raw);
      }
      this.changed();
      void this.persist();
      return;
    }
    let active = 0;
    for (const raw of items) {
      this.items.set(raw.id, raw);
      if (raw.status !== "downloading") continue;
      if (this.maxDownloads === 0 || active < this.maxDownloads) {
        this.startEngine(raw);
        active++;
      } else {
        raw.status = "queued";
      }
    }
    if (active > 0) this.ensurePoll();
    this.changed();
    this.promote();
  }

  restoreHistory(items: HistoryItem[]): void {
    this.history = items.slice(0, HISTORY_MAX);
  }

  getHistory(): HistoryItem[] {
    return this.history;
  }

  setSeedTime(id: string, seedTimeMs: number | undefined): boolean {
    const it = this.items.get(id);
    if (it) {
      if (seedTimeMs === undefined) delete it.seedTimeMs;
      else it.seedTimeMs = seedTimeMs;
      void this.persist();
    }
    const h = this.history.find((x) => x.id === id);
    if (h) {
      if (seedTimeMs === undefined) delete h.seedTimeMs;
      else h.seedTimeMs = seedTimeMs;
      void saveHistory(this.history).catch(() => {});
    }
    if (!it && !h) return false;
    this.changed();
    return true;
  }

  private recordHistory(it: QueueItem): void {
    const rec: HistoryItem = {
      id: it.id,
      name: it.name,
      source: it.source,
      sizeBytes: it.totalBytes,
      magnet: it.magnet,
      dir: it.dir,
      ...(it.storageLayout ? { storageLayout: it.storageLayout } : {}),
      completedAt: Date.now(),
      ...(it.seedTimeMs !== undefined ? { seedTimeMs: it.seedTimeMs } : {}),
    };
    this.history = [rec, ...this.history.filter((h) => h.id !== it.id)].slice(0, HISTORY_MAX);
    void saveHistory(this.history).catch(() => {});
  }

  removeHistory(id: string): void {
    const next = this.history.filter((h) => h.id !== id);
    if (next.length === this.history.length) return;
    this.history = next;
    if (this.seeds.has(id)) {
      this.engine.remove(id);
      this.seeds.delete(id);
      this.strayHits.delete(id);
      this.seedStartedAt.delete(id);
      void this.persistSeeds();
      this.maybeStopPoll();
    }
    deleteTorrentMeta(id);
    void saveHistory(this.history).catch(() => {});
    this.changed();
  }

  clearHistory(): void {
    if (this.history.length === 0) return;
    for (const h of this.history) deleteTorrentMeta(h.id);
    this.history = [];
    if (this.seeds.size > 0) {
      for (const id of this.seeds.keys()) this.engine.remove(id);
      this.seeds.clear();
      this.strayHits.clear();
      this.seedStartedAt.clear();
      void this.persistSeeds();
      this.maybeStopPoll();
    }
    void saveHistory(this.history).catch(() => {});
    this.changed();
  }

  private changed(): void {
    this.emit("update");
  }

  private async persist(): Promise<void> {
    await saveQueue(this.getItems()).catch(() => {});
  }

  persistSync(): void {
    saveQueueSync(this.getItems());
    saveHistorySync(this.history);
    saveSeedsSync(this.seedRecords());
    disarmBootMarker();
  }

  suspend(): void {
    this.zeroLiveStats();
    this.persistSync();
    if (this.poll) {
      clearInterval(this.poll);
      this.poll = null;
    }
    this.engine.destroy();
  }
}
