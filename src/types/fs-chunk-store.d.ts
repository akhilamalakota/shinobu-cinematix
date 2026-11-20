declare module "fs-chunk-store" {
  export interface ChunkStoreFile {
    path: string;
    length: number;
    offset?: number;
  }

  export interface ChunkStoreOptions {
    files?: ChunkStoreFile[];
    torrent?: {
      name?: string;
    };
    [key: string]: unknown;
  }

  export default class FSChunkStore {
    constructor(
      chunkLength: number,
      options?: ChunkStoreOptions,
    );
  }
}