import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  SinkContract,
  SinkLimits,
  ConfigureResult,
  TestResult,
  DeliveryOutcome,
  SinkHealthStatus,
  Message,
} from '@chat-bridge/types';

const FOLDER_MISSING_ERROR =
  'No archive folder is set. Click "Choose folder" and pick where the daily message files should be saved.';

export class ArchiveSink implements SinkContract {
  public readonly sinkId = 'archive';
  public readonly name = 'Archive';
  public readonly limits: SinkLimits = {
    batchSize: 100,
    requestsPerMinute: 600,
  };

  private folder: string | undefined;
  private consecutiveFailures = 0;
  private lastDeliveryTime: string | undefined;
  /** Message IDs already stored, keyed by day file name. Loaded once per day file. */
  private readonly knownIds = new Map<string, Set<string>>();
  /** Serialises deliveries so appends to the same day file never interleave. */
  private queue: Promise<unknown> = Promise.resolve();

  public async configure(
    settings: Record<string, unknown>,
  ): Promise<ConfigureResult & { errors?: { folder: string } | undefined }> {
    const folder = settings.folder;
    if (typeof folder !== 'string' || !folder.trim()) {
      return { valid: false, errors: { folder: FOLDER_MISSING_ERROR } };
    }

    this.folder = folder.trim();
    this.knownIds.clear();
    this.consecutiveFailures = 0;
    return { valid: true };
  }

  public async test(): Promise<TestResult> {
    if (!this.folder) {
      return { ok: false, message: FOLDER_MISSING_ERROR };
    }

    try {
      await fs.mkdir(this.folder, { recursive: true });
      await fs.access(this.folder, fs.constants.W_OK);
      return { ok: true, message: `Messages will be saved in ${this.folder}.` };
    } catch {
      return {
        ok: false,
        message: `The archive folder ${this.folder} cannot be written to. Click "Choose folder" and pick a folder you can save files in.`,
      };
    }
  }

  public deliver(batch: Message[]): Promise<DeliveryOutcome[]> {
    const run = this.queue.then(() => this.deliverNow(batch));
    this.queue = run.catch(() => undefined);
    return run;
  }

  public async health(): Promise<SinkHealthStatus> {
    if (!this.folder) {
      return { health: 'down', reason: FOLDER_MISSING_ERROR };
    }
    if (this.consecutiveFailures > 0) {
      return {
        health: 'degraded',
        reason: 'Recent messages could not be saved to the archive folder. Click "Test" to check the folder.',
        lastSuccessfulDelivery: this.lastDeliveryTime,
        consecutiveFailures: this.consecutiveFailures,
      };
    }
    return {
      health: 'ok',
      reason: 'Messages are being saved to the archive folder.',
      lastSuccessfulDelivery: this.lastDeliveryTime,
    };
  }

  private async deliverNow(batch: Message[]): Promise<DeliveryOutcome[]> {
    const folder = this.folder;
    if (!folder) {
      return batch.map((msg) => ({
        messageId: msg.id,
        outcome: 'refused',
        reason: FOLDER_MISSING_ERROR,
      }));
    }

    const outcomes: DeliveryOutcome[] = [];
    const pending = new Map<string, { lines: string[]; indexes: number[]; ids: string[] }>();

    for (const msg of batch) {
      const day = dayOf(msg.time);
      if (!day) {
        outcomes.push({
          messageId: msg.id,
          outcome: 'refused',
          reason: 'This message has no valid date, so it cannot be filed under a day.',
        });
        continue;
      }

      const known = await this.idsForDay(folder, day);
      const group = pending.get(day);
      if (known.has(msg.id) || group?.ids.includes(msg.id)) {
        outcomes.push({
          messageId: msg.id,
          outcome: 'duplicate',
          reason: 'This message is already saved in the archive.',
        });
        continue;
      }

      const entry = group ?? { lines: [], indexes: [], ids: [] };
      entry.lines.push(`${JSON.stringify(msg)}\n`);
      entry.indexes.push(outcomes.length);
      entry.ids.push(msg.id);
      pending.set(day, entry);
      outcomes.push({ messageId: msg.id, outcome: 'accepted' });
    }

    if (pending.size === 0) {
      return outcomes;
    }

    try {
      await fs.mkdir(folder, { recursive: true });
    } catch {
      this.consecutiveFailures++;
      return outcomes.map((o) =>
        o.outcome === 'accepted' ? { ...o, outcome: 'refused', reason: unwritableReason(folder) } : o,
      );
    }

    for (const [day, entry] of pending) {
      try {
        await fs.appendFile(path.join(folder, `${day}.jsonl`), entry.lines.join(''), 'utf-8');
        const known = await this.idsForDay(folder, day);
        for (const id of entry.ids) {
          known.add(id);
        }
        this.consecutiveFailures = 0;
        this.lastDeliveryTime = new Date().toISOString();
      } catch {
        this.consecutiveFailures++;
        entry.indexes.forEach((index, i) => {
          outcomes[index] = {
            messageId: entry.ids[i] ?? '',
            outcome: 'refused',
            reason: unwritableReason(folder),
          };
        });
      }
    }

    return outcomes;
  }

  private async idsForDay(folder: string, day: string): Promise<Set<string>> {
    const cached = this.knownIds.get(day);
    if (cached) {
      return cached;
    }

    const ids = new Set<string>();
    let content = '';
    try {
      content = await fs.readFile(path.join(folder, `${day}.jsonl`), 'utf-8');
    } catch {
      content = '';
    }
    for (const line of content.split('\n')) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as { id?: unknown };
        if (typeof parsed.id === 'string') {
          ids.add(parsed.id);
        }
      } catch {
        continue;
      }
    }
    this.knownIds.set(day, ids);
    return ids;
  }
}

function dayOf(time: string): string | undefined {
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date.toISOString().slice(0, 10);
}

function unwritableReason(folder: string): string {
  return `Messages could not be saved in ${folder}. Click "Choose folder" and pick a folder you can save files in.`;
}
