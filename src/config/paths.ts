
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import envPaths from "env-paths";

export const APP_NAME = "torlink";

const base = envPaths(APP_NAME, { suffix: "" });

const override = process.env.TORLINK_STATE_DIR;
const dataDir = override ? path.join(override, "data") : base.data;
const configDir = override ? path.join(override, "config") : base.config;

export const defaultDownloadDir = path.join(
  os.homedir(),
  "Downloads",
  "SHINOBU CINEMATIX",
);

export const configFile = path.join(configDir, "config.json");

export const queueFile = path.join(dataDir, "queue.json");

export const historyFile = path.join(dataDir, "history.json");

export const seedsFile = path.join(dataDir, "seeds.json");

export const torrentsDir = path.join(dataDir, "torrents");

export const bootMarkerFile = path.join(dataDir, "boot.marker");

export const logsDir = path.join(dataDir, "logs");

export const handoffEndpoint =
  process.platform === "win32"
    ? `\\\\.\\pipe\\torlink-${createHash("sha1").update(dataDir).digest("hex").slice(0, 12)}`
    : path.join(dataDir, "handoff.sock");
