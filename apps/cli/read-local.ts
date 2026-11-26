import { open } from "node:fs/promises";

/** Maximum size of each UTF-8 input file, measured in bytes. */
export const MAX_INPUT_BYTES = 1024 * 1024;

/** Read from the opened handle in bounded chunks, including through symbolic links. */
export async function readLocalText(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      // Read at most one extra byte to detect a file that exceeds the limit.
      const chunk = Buffer.allocUnsafe(
        Math.min(64 * 1024, MAX_INPUT_BYTES + 1 - total),
      );
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_INPUT_BYTES) throw new Error("Input exceeds size limit");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks, total),
    );
  } finally {
    await file.close();
  }
}
