
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { configFile, defaultDownloadDir } from "./paths";
import { serializeWrites, writeJsonAtomic } from "../util/atomic";

export interface Config {
  downloadDir: string;
  trackers: string[];
}

const legacyDownloadDir = path.join(os.homedir(), "Downloads", "torlink");

function normalizeDir(dir: string): string {
  return path.resolve(dir).replace(/[\\/]+$/, "").toLowerCase();
}

export const defaultConfig: Config = {
  downloadDir: defaultDownloadDir,
  trackers: [],
};

export async function loadConfig(): Promise<Config> {
  let raw: string;

  try {
    raw = await fs.readFile(configFile, "utf8");
  } catch {
    return { ...defaultConfig, trackers: [] };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<Config>;

    let downloadDir =
      typeof parsed.downloadDir === "string" && parsed.downloadDir
        ? parsed.downloadDir
        : defaultDownloadDir;

    if (normalizeDir(downloadDir) === normalizeDir(legacyDownloadDir)) {
      downloadDir = defaultDownloadDir;
    }

    return {
      downloadDir,
      trackers: Array.isArray(parsed.trackers)
        ? parsed.trackers.filter(
            (t): t is string => typeof t === "string" && t.length > 0,
          )
        : [],
    };
  } catch {
    return { ...defaultConfig, trackers: [] };
  }
}

const write = serializeWrites();

export function saveConfig(config: Config): Promise<void> {
  return write(() => writeJsonAtomic(configFile, config));
}
