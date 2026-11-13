import { describe, it, expect } from 'vitest';
import type { Message } from '@chat-bridge/types';
import { dayFileName, messageLine } from './day-file.js';

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'fake:acct-1:native-001',
    network: 'fake',
    account: 'acct-1',
    thread: 'thread-1',
    threadKind: 'dm',
    direction: 'inbound',
    time: '2026-11-13T00:00:00Z',
    from: { accountId: 'contact-a', displayName: 'Test Contact A' },
    to: [{ accountId: 'acct-1', displayName: 'Test Rep' }],
    text: 'hello',
    ...overrides,
  };
}

describe('US-K1-01: Archive day files', () => {
  describe('dayFileName', () => {
    it('test_day_file_name_uses_utc_day_at_midnight_boundary', () => {
      expect(dayFileName('2026-11-12T23:59:59Z')).toBe('2026-11-12.jsonl');
      expect(dayFileName('2026-11-13T00:00:00Z')).toBe('2026-11-13.jsonl');
    });

    it('test_day_file_name_converts_offset_time_to_utc_day', () => {
      expect(dayFileName('2026-11-13T01:30:00+07:00')).toBe('2026-11-12.jsonl');
    });

    it('test_day_file_name_converts_negative_offset_to_next_utc_day', () => {
      expect(dayFileName('2026-11-12T20:00:00-05:00')).toBe('2026-11-13.jsonl');
    });

    it('test_day_file_name_handles_milliseconds', () => {
      expect(dayFileName('2026-11-13T00:00:00.123Z')).toBe('2026-11-13.jsonl');
    });

    it('test_day_file_name_pads_month_and_day', () => {
      expect(dayFileName('2026-01-05T12:00:00Z')).toBe('2026-01-05.jsonl');
    });

    it('test_day_file_name_returns_undefined_for_invalid_time', () => {
      expect(() => dayFileName('not-a-date')).not.toThrow();
      expect(dayFileName('not-a-date')).toBeUndefined();
    });

    it('test_day_file_name_returns_undefined_for_empty_time', () => {
      expect(() => dayFileName('')).not.toThrow();
      expect(dayFileName('')).toBeUndefined();
    });
  });

  describe('messageLine', () => {
    it('test_message_line_is_one_line_when_text_has_newline', () => {
      const message = makeMessage({ text: 'first line\nsecond line\r\nthird' });
      const line = messageLine(message);

      expect(line.endsWith('\n')).toBe(true);
      expect(line.endsWith('\n\n')).toBe(false);
      expect(line.split('\n')).toHaveLength(2);
      expect(line.indexOf('\n')).toBe(line.length - 1);
      expect(JSON.parse(line)).toEqual(message);
    });

    it('test_message_line_keeps_every_field', () => {
      const message = makeMessage({
        threadKind: 'group',
        participants: [
          { accountId: 'contact-a', displayName: 'Test Contact A', phone: '+10000000000' },
          { accountId: 'contact-b', displayName: 'Test Contact B' },
        ],
        truncated: true,
        placeholder: '[image: sample.jpg, 1.2 MB]',
        rawNativeId: 'native-001',
      });
      const line = messageLine(message);

      expect(line).toBe(`${JSON.stringify(message)}\n`);
      expect(JSON.parse(line)).toEqual(message);
    });
  });
});
