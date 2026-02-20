/**
 * Structured JSON request logger with size-based rotation.
 *
 * Writes one JSON object per line (JSONL format) to a log file.
 * When the file exceeds MAX_SIZE_BYTES, rotates:
 *   requests.log -> requests.log.1  (previous .1 is deleted)
 *
 * Keeps at most 2 files: current + 1 rotated.
 *
 * Uses async I/O and batched writes to avoid blocking the event loop.
 */

import { getConfigDir } from "@shetty4l/core/config";
import { createLogger } from "@shetty4l/core/log";
import { existsSync, mkdirSync } from "fs";
import { appendFile, rename, stat, unlink } from "fs/promises";
import { join } from "path";

const log = createLogger("synapse");

export interface RequestLogEntry {
  timestamp: string;
  model: string;
  provider: string | null;
  latencyMs: number;
  status: number;
  streaming: boolean;
  attempted: string[];
  skipped: string[];
  error?: string;
}

const MAX_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
const FLUSH_INTERVAL_MS = 1_000; // Flush buffer every second
const DEFAULT_LOG_DIR = join(getConfigDir("synapse"), "logs");

export class RequestLogger {
  private readonly logPath: string;
  private readonly rotatedPath: string;
  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private rotating = false;

  constructor(logDir?: string) {
    const dir = logDir ?? DEFAULT_LOG_DIR;
    // Sync mkdir only at startup — acceptable
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.logPath = join(dir, "requests.log");
    this.rotatedPath = join(dir, "requests.log.1");

    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => log(`log flush failed: ${err}`));
    }, FLUSH_INTERVAL_MS);
  }

  /**
   * Log a request entry. Buffers the line for async flushing.
   */
  log(entry: RequestLogEntry): void {
    this.buffer.push(JSON.stringify(entry) + "\n");
  }

  /**
   * Flush buffered entries to disk asynchronously.
   */
  async flush(): Promise<void> {
    if (this.buffer.length === 0 || this.flushing) return;
    this.flushing = true;

    try {
      const lines = this.buffer.splice(0);
      const data = lines.join("");

      await appendFile(this.logPath, data);

      // Check rotation after write
      await this.rotateIfNeeded();
    } catch (err) {
      log(`log write failed: ${err}`);
    } finally {
      this.flushing = false;
    }
  }

  private async rotateIfNeeded(): Promise<void> {
    if (this.rotating) return;
    this.rotating = true;

    try {
      const stats = await stat(this.logPath).catch(() => null);
      if (!stats || stats.size < MAX_SIZE_BYTES) return;

      // Rotate: delete .1, rename current to .1
      await unlink(this.rotatedPath).catch(() => {});
      await rename(this.logPath, this.rotatedPath);
      log("rotated request log");
    } catch (error) {
      log(`log rotation failed: ${error}`);
    } finally {
      this.rotating = false;
    }
  }

  /**
   * Stop the flush timer and drain remaining entries.
   */
  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}

/**
 * Create a log entry from a route result.
 */
export function createLogEntry(
  model: string,
  providerName: string | null,
  status: number,
  streaming: boolean,
  latencyMs: number,
  attempted: string[],
  skipped: string[],
  error?: string,
): RequestLogEntry {
  return {
    timestamp: new Date().toISOString(),
    model,
    provider: providerName,
    latencyMs: Math.round(latencyMs),
    status,
    streaming,
    attempted,
    skipped,
    error,
  };
}
