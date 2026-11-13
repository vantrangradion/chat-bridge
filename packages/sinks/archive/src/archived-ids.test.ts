import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Message } from '@chat-bridge/types';
import { ArchivedIds } from './archived-ids.js';

function syntheticMessage(id: string, time: string): Message {
  return {
    id,
    network: 'fake',
    account: 'fake-account-1',
    thread: 'fake-thread-1',
    threadKind: 'dm',
    direction: 'inbound',
    time,
    from: { accountId: 'fake-contact-1', displayName: 'Test Contact' },
    to: [{ accountId: 'fake-account-1', displayName: 'Test Rep' }],
    text: `synthetic text for ${id}`,
  };
}

function line(id: string, time = '2026-11-12T09:00:00+07:00'): string {
  return JSON.stringify(syntheticMessage(id, time));
}

function writeLines(folder: string, name: string, lines: string[]): void {
  fs.writeFileSync(path.join(folder, name), `${lines.join('\n')}\n`);
}

function snapshotFolder(folder: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const name of fs.readdirSync(folder).sort()) {
    snapshot[name] = fs.readFileSync(path.join(folder, name), 'utf8');
  }
  return snapshot;
}

describe('US-K1-01: Archive reads the message ids already stored in its folder', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-archived-ids-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('Scenario 1: Daily JSONL partitioning, each message written exactly once', () => {
    it('test_reads_ids_from_every_jsonl_file_in_folder', async () => {
      writeLines(root, '2026-11-12.jsonl', [
        line('fake:fake-account-1:n1'),
        line('fake:fake-account-1:n2'),
      ]);
      writeLines(root, '2026-11-13.jsonl', [
        line('fake:fake-account-1:n3', '2026-11-13T10:00:00+07:00'),
        line('fake:fake-account-1:n4', '2026-11-13T11:00:00+07:00'),
      ]);

      const archived = await ArchivedIds.fromFolder(root);

      expect(archived.has('fake:fake-account-1:n1')).toBe(true);
      expect(archived.has('fake:fake-account-1:n2')).toBe(true);
      expect(archived.has('fake:fake-account-1:n3')).toBe(true);
      expect(archived.has('fake:fake-account-1:n4')).toBe(true);
      expect(archived.has('fake:fake-account-1:n5')).toBe(false);
    });

    it('test_ignores_bad_lines_and_keeps_reading_the_file', async () => {
      writeLines(root, '2026-11-12.jsonl', [
        line('fake:fake-account-1:good1'),
        '',
        'not json',
        JSON.stringify({ text: 'a line with no id' }),
        JSON.stringify({ id: 5, text: 'a line with a number id' }),
        JSON.stringify({ id: null }),
        JSON.stringify({ id: { native: 'x' } }),
        '"just a string"',
        '42',
        'null',
        '[1, 2]',
        line('fake:fake-account-1:good2'),
      ]);

      const archived = await ArchivedIds.fromFolder(root);

      expect(archived.has('fake:fake-account-1:good1')).toBe(true);
      expect(archived.has('fake:fake-account-1:good2')).toBe(true);
      expect(archived.has('5')).toBe(false);
      expect(archived.has('')).toBe(false);
      expect(archived.has('not json')).toBe(false);
      expect(archived.has('null')).toBe(false);
      expect(archived.has('just a string')).toBe(false);
    });

    it('test_bad_line_in_one_file_does_not_stop_other_files', async () => {
      writeLines(root, '2026-11-12.jsonl', ['{broken', line('fake:fake-account-1:a1')]);
      writeLines(root, '2026-11-13.jsonl', [line('fake:fake-account-1:b1'), 'not json']);

      const archived = await ArchivedIds.fromFolder(root);

      expect(archived.has('fake:fake-account-1:a1')).toBe(true);
      expect(archived.has('fake:fake-account-1:b1')).toBe(true);
    });

    it('test_missing_folder_gives_empty_set_and_is_not_created', async () => {
      const missing = path.join(root, 'does-not-exist');

      const archived = await ArchivedIds.fromFolder(missing);

      expect(archived).toBeInstanceOf(ArchivedIds);
      expect(archived.has('fake:fake-account-1:n1')).toBe(false);
      expect(fs.existsSync(missing)).toBe(false);
    });

    it('test_empty_folder_gives_empty_set', async () => {
      const archived = await ArchivedIds.fromFolder(root);

      expect(archived.has('fake:fake-account-1:n1')).toBe(false);
    });

    it('test_ignores_files_not_ending_in_jsonl', async () => {
      writeLines(root, 'notes.txt', [line('fake:fake-account-1:txt1')]);
      writeLines(root, 'messages.json', [line('fake:fake-account-1:json1')]);
      writeLines(root, '2026-11-12.jsonl.bak', [line('fake:fake-account-1:bak1')]);
      writeLines(root, '2026-11-12.jsonl', [line('fake:fake-account-1:kept1')]);

      const archived = await ArchivedIds.fromFolder(root);

      expect(archived.has('fake:fake-account-1:txt1')).toBe(false);
      expect(archived.has('fake:fake-account-1:json1')).toBe(false);
      expect(archived.has('fake:fake-account-1:bak1')).toBe(false);
      expect(archived.has('fake:fake-account-1:kept1')).toBe(true);
    });

    it('test_does_not_read_sub_folders', async () => {
      const sub = path.join(root, 'older');
      fs.mkdirSync(sub);
      writeLines(sub, '2026-11-01.jsonl', [line('fake:fake-account-1:sub1')]);
      writeLines(root, '2026-11-12.jsonl', [line('fake:fake-account-1:top1')]);

      const archived = await ArchivedIds.fromFolder(root);

      expect(archived.has('fake:fake-account-1:sub1')).toBe(false);
      expect(archived.has('fake:fake-account-1:top1')).toBe(true);
    });

    it('test_add_remembers_id_without_touching_files', async () => {
      writeLines(root, '2026-11-12.jsonl', [line('fake:fake-account-1:n1')]);
      writeLines(root, 'notes.txt', ['synthetic note']);
      const before = snapshotFolder(root);
      const archived = await ArchivedIds.fromFolder(root);

      expect(archived.has('m1')).toBe(false);
      archived.add('m1');

      expect(archived.has('m1')).toBe(true);
      expect(archived.has('fake:fake-account-1:n1')).toBe(true);
      expect(snapshotFolder(root)).toEqual(before);
    });

    it('test_add_on_missing_folder_does_not_create_it', async () => {
      const missing = path.join(root, 'does-not-exist');
      const archived = await ArchivedIds.fromFolder(missing);

      archived.add('m1');

      expect(archived.has('m1')).toBe(true);
      expect(fs.existsSync(missing)).toBe(false);
    });
  });
});
