import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataRoot, mediaPath } from "./store";

export interface PrivateMediaStorage {
  write(key: string, bytes: Buffer): Promise<void>;
  read(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

class FileMediaStorage implements PrivateMediaStorage {
  async write(key: string, bytes: Buffer) {
    await mkdir(path.join(dataRoot, "media"), { recursive: true, mode: 0o700 });
    await writeFile(mediaPath(key), bytes, { flag: "wx", mode: 0o600 });
  }
  read(key: string) { return readFile(mediaPath(key)); }
  async delete(key: string) { await unlink(mediaPath(key)).catch(() => {}); }
}

export const privateMedia = new FileMediaStorage();
