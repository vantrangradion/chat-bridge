import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Message } from '@chat-bridge/types';
import { executeCli } from './cli.js';
import { CliContext } from './config.js';
import {
  evaluateAppHealth,
  SLOW_QUEUE_THRESHOLD,
  SLOW_CPU_PERCENT_THRESHOLD,
  PROBLEM_CPU_PERCENT_THRESHOLD,
  SLOW_MEMORY_MB_THRESHOLD,
  PROBLEM_MEMORY_MB_THRESHOLD,
  PROBLEM_ERROR_COUNT_THRESHOLD,
} from './commands/status.js';

describe('US-I1-01: Developer and QA Command-Line Interface (CLI) Parity', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-bridge-cli-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('Scenario 1: Standard POSIX flags and exit codes', () => {
    it('prints help message with --help and exits with 0', async () => {
      const result = await executeCli(['--help'], { dataDir: tempDir });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('chat-bridge');
      expect(result.stdout).toContain('status');
      expect(result.stdout).toContain('chats');
      expect(result.stdout).toContain('filters');
      expect(result.stdout).toContain('login');
      expect(result.stdout).toContain('sink');
      expect(result.stdout).toContain('run');
      expect(result.stdout).toContain('history');
      expect(result.stdout).toContain('ui');
    });

    it('prints version with --version and exits with 0', async () => {
      const result = await executeCli(['--version'], { dataDir: tempDir });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/0\.1\.0/);
    });

    it('returns non-zero exit code on unknown command', async () => {
      const result = await executeCli(['unknown-command'], { dataDir: tempDir });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Unknown command');
    });
  });

  describe('Scenario 2: Machine-readable status output', () => {
    it('executes status --json and returns structured telemetry and queue counts', async () => {
      const result = await executeCli(['status', '--json'], { dataDir: tempDir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed).toBeDefined();
      expect(parsed.sources).toBeDefined();
      expect(parsed.sinks).toBeDefined();
      expect(parsed.outbox).toBeDefined();
      expect(parsed.telemetry).toBeDefined();
      expect(typeof parsed.isPaused).toBe('boolean');
    });

    it('executes status with human-readable text output', async () => {
      const result = await executeCli(['status'], { dataDir: tempDir });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Sources');
      expect(result.stdout).toContain('Where to send');
      expect(result.stdout).toContain('Waiting messages');
    });
  });

  describe('Scenario 3: Chat Picker Management (chat-bridge chats)', () => {
    it('lists chats, picks a chat, and unpicks a chat', async () => {
      // 1. List chats (initially empty)
      const listEmpty = await executeCli(['chats', 'list', '--json'], { dataDir: tempDir });
      expect(listEmpty.exitCode).toBe(0);
      const emptyParsed = JSON.parse(listEmpty.stdout);
      expect(Array.isArray(emptyParsed)).toBe(true);

      // 2. Pick a chat ID
      const pickRes = await executeCli(['chats', 'pick', 'chat-cust-001', '--json'], { dataDir: tempDir });
      expect(pickRes.exitCode).toBe(0);
      const pickParsed = JSON.parse(pickRes.stdout);
      expect(pickParsed.ok).toBe(true);
      expect(pickParsed.id).toBe('chat-cust-001');
      expect(pickParsed.isTicked).toBe(true);

      // 3. List chats again to verify it is ticked
      const listRes = await executeCli(['chats', 'list', '--json'], { dataDir: tempDir });
      expect(listRes.exitCode).toBe(0);
      const listParsed = JSON.parse(listRes.stdout);
      const found = listParsed.find((c: { id: string }) => c.id === 'chat-cust-001');
      expect(found).toBeDefined();
      expect(found.isTicked).toBe(true);

      // 4. Unpick the chat
      const unpickRes = await executeCli(['chats', 'unpick', 'chat-cust-001', '--json'], { dataDir: tempDir });
      expect(unpickRes.exitCode).toBe(0);
      const unpickParsed = JSON.parse(unpickRes.stdout);
      expect(unpickParsed.ok).toBe(true);
      expect(unpickParsed.isTicked).toBe(false);
    });
  });

  describe('Scenario 4: Filter Configuration (chat-bridge filters)', () => {
    it('shows filters, sets allowGroups, and blocks/unblocks contacts', async () => {
      // 1. Show filters
      const showRes = await executeCli(['filters', 'show', '--json'], { dataDir: tempDir });
      expect(showRes.exitCode).toBe(0);
      const showParsed = JSON.parse(showRes.stdout);
      expect(showParsed.allowGroups).toBe(false); // Groups off by default
      expect(showParsed.otpFilterEnabled).toBe(true); // OTP active by default

      // 2. Enable groups
      const setGroupsRes = await executeCli(['filters', 'set', 'allowGroups', 'true', '--json'], { dataDir: tempDir });
      expect(setGroupsRes.exitCode).toBe(0);
      const setGroupsParsed = JSON.parse(setGroupsRes.stdout);
      expect(setGroupsParsed.allowGroups).toBe(true);

      // 3. Block a contact
      const blockRes = await executeCli(['filters', 'block', '+84901234567', '--json'], { dataDir: tempDir });
      expect(blockRes.exitCode).toBe(0);
      const blockParsed = JSON.parse(blockRes.stdout);
      expect(blockParsed.blockedContacts).toContain('84901234567');

      // 4. Unblock the contact
      const unblockRes = await executeCli(['filters', 'unblock', '+84901234567', '--json'], { dataDir: tempDir });
      expect(unblockRes.exitCode).toBe(0);
      const unblockParsed = JSON.parse(unblockRes.stdout);
      expect(unblockParsed.blockedContacts).not.toContain('84901234567');
    });
  });

  describe('Scenario 5: Login Flow (chat-bridge login)', () => {
    it('initiates login for WhatsApp and yields authentication/qr event', async () => {
      const result = await executeCli(['login', 'whatsapp', '--json'], { dataDir: tempDir });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.network).toBe('whatsapp');
      expect(parsed.status).toBeDefined();
    });

    it('initiates login for Zalo and yields authentication event', async () => {
      const result = await executeCli(['login', 'zalo', '--json'], { dataDir: tempDir });
      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.network).toBe('zalo');
      expect(parsed.status).toBeDefined();
    });

    it('rejects unsupported login network', async () => {
      const result = await executeCli(['login', 'telegram', '--json'], { dataDir: tempDir });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('Unsupported network');
    });
  });

  describe('Scenario 6: Destination Management (chat-bridge sink)', () => {
    it('adds a sink, lists sinks, tests sink, and removes sink', async () => {
      const validConfig = JSON.stringify({
        endpointUrl: 'http://localhost:3000/webhooks/ext/openchannel/receive/test-ref',
        sharedSecret: 'test-shared-secret-32-chars-long-key',
        channelRef: 'test-ref',
      });

      // 1. Add Margince sink
      const addRes = await executeCli(['sink', 'add', 'margince', validConfig, '--json'], { dataDir: tempDir });
      expect(addRes.exitCode).toBe(0);
      const addParsed = JSON.parse(addRes.stdout);
      expect(addParsed.ok).toBe(true);

      // 2. List sinks
      const listRes = await executeCli(['sink', 'list', '--json'], { dataDir: tempDir });
      expect(listRes.exitCode).toBe(0);
      const listParsed = JSON.parse(listRes.stdout);
      expect(listParsed.find((s: { type: string }) => s.type === 'margince')).toBeDefined();

      // 3. Test sink
      const testRes = await executeCli(['sink', 'test', 'margince', '--json'], { dataDir: tempDir });
      expect(testRes.exitCode).toBe(0);
      const testParsed = JSON.parse(testRes.stdout);
      expect(testParsed).toBeDefined();

      // 4. Remove sink
      const removeRes = await executeCli(['sink', 'remove', 'margince', '--json'], { dataDir: tempDir });
      expect(removeRes.exitCode).toBe(0);
      const removeParsed = JSON.parse(removeRes.stdout);
      expect(removeParsed.ok).toBe(true);
    });

    it('rejects adding sink with invalid configuration', async () => {
      const invalidConfig = 'invalid-not-json-or-missing-fields';
      const addRes = await executeCli(['sink', 'add', 'margince', invalidConfig, '--json'], { dataDir: tempDir });
      expect(addRes.exitCode).not.toBe(0);
      expect(addRes.stderr).toContain('Invalid configuration');
    });
  });

  describe('Scenario 7: Replay Engine Run (chat-bridge run)', () => {
    it('runs pipeline with --fake and completes replay', async () => {
      const runRes = await executeCli(['run', '--fake', '--headless', '--json', '--timeout', '500'], { dataDir: tempDir });
      expect(runRes.exitCode).toBe(0);
      const parsed = JSON.parse(runRes.stdout);
      expect(parsed.ok).toBe(true);
      expect(parsed.processedCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Scenario 8: Historical Import (chat-bridge history)', () => {
    it('imports history from fake source with since date', async () => {
      const res = await executeCli(['history', 'import', 'fake', '--since', '2026-11-01', '--json'], { dataDir: tempDir });
      expect(res.exitCode).toBe(0);
      const parsed = JSON.parse(res.stdout);
      expect(parsed.importedCount).toBeGreaterThanOrEqual(0);
      expect(parsed.network).toBe('fake');
    });
  });

  describe('Scenario 9: Local UI Command (chat-bridge ui)', () => {
    it('outputs local web interface URL', async () => {
      const res = await executeCli(['ui', '--port', '4173', '--json'], { dataDir: tempDir });
      expect(res.exitCode).toBe(0);
      const parsed = JSON.parse(res.stdout);
      expect(parsed.url).toContain('http://127.0.0.1:4173');
    });
  });

  describe('Scenario 10: Mistyped command suggestions', () => {
    it('suggests "status" for "stauts" with help hint on stderr and exit code 1', async () => {
      const res = await executeCli(['stauts'], { dataDir: tempDir });
      expect(res.exitCode).toBe(1);
      expect(res.stdout).toBe('');
      expect(res.stderr).toContain('Unknown command: "stauts". Did you mean "status"?');
      expect(res.stderr).toContain('Run "chat-bridge --help" for available commands.');
    });

    it('suggests a known command when within 1 or 2 edits of the input', async () => {
      const oneEdit = await executeCli(['chat'], { dataDir: tempDir });
      expect(oneEdit.exitCode).toBe(1);
      expect(oneEdit.stderr).toContain('Unknown command: "chat". Did you mean "chats"?');
      expect(oneEdit.stderr).toContain('Run "chat-bridge --help" for available commands.');

      const twoEdits = await executeCli(['stat'], { dataDir: tempDir });
      expect(twoEdits.exitCode).toBe(1);
      expect(twoEdits.stderr).toContain('Unknown command: "stat". Did you mean "status"?');
      expect(twoEdits.stderr).toContain('Run "chat-bridge --help" for available commands.');
    });

    it('keeps the error message unchanged when no command is within 2 edits', async () => {
      const threeEdits = await executeCli(['statusxyz'], { dataDir: tempDir });
      expect(threeEdits.exitCode).toBe(1);
      expect(threeEdits.stderr).toBe(
        'Unknown command: "statusxyz". Run "chat-bridge --help" for available commands.'
      );

      const farInput = await executeCli(['unknown-command'], { dataDir: tempDir });
      expect(farInput.exitCode).toBe(1);
      expect(farInput.stderr).toBe(
        'Unknown command: "unknown-command". Run "chat-bridge --help" for available commands.'
      );
    });

    it('ignores case when matching mistyped commands', async () => {
      const res = await executeCli(['STAUTS'], { dataDir: tempDir });
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toContain('Did you mean "status"?');
      expect(res.stderr).toContain('Run "chat-bridge --help" for available commands.');
    });

    it('includes suggestion field in --json error output when a suggestion exists and omits it otherwise', async () => {
      const withSuggestion = await executeCli(['stauts', '--json'], { dataDir: tempDir });
      expect(withSuggestion.exitCode).toBe(1);
      expect(withSuggestion.stdout).toBe('');
      const parsedWith = JSON.parse(withSuggestion.stderr);
      expect(parsedWith.suggestion).toBe('status');
      expect(parsedWith.error).toContain('Unknown command: "stauts". Did you mean "status"?');
      expect(parsedWith.error).toContain('Run "chat-bridge --help" for available commands.');

      const withoutSuggestion = await executeCli(['statusxyz', '--json'], { dataDir: tempDir });
      expect(withoutSuggestion.exitCode).toBe(1);
      expect(withoutSuggestion.stdout).toBe('');
      const parsedWithout = JSON.parse(withoutSuggestion.stderr);
      expect(parsedWithout.error).toBe(
        'Unknown command: "statusxyz". Run "chat-bridge --help" for available commands.'
      );
      expect(parsedWithout).not.toHaveProperty('suggestion');
    });
  });

  describe('Scenario 11: App health telemetry and verdict (Spec C-9)', () => {
    function makeSyntheticMessage(index: number): Message {
      return {
        id: `fake:test-account:msg-${index}`,
        network: 'fake',
        account: 'test-account',
        thread: 'thread-dm-synthetic-1',
        threadKind: 'dm',
        direction: 'inbound',
        time: new Date().toISOString(),
        from: {
          accountId: 'synthetic-sender-1',
          displayName: 'Synthetic Contact',
        },
        to: [
          {
            accountId: 'test-account',
            displayName: 'Synthetic Rep',
          },
        ],
        text: `Synthetic test message ${index}`,
      };
    }

    it('returns cpuPercent, messagesPerMinute, errorCount, and health in status --json telemetry', async () => {
      const result = await executeCli(['status', '--json'], { dataDir: tempDir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(typeof parsed.telemetry.memoryUsageMb).toBe('number');
      expect(typeof parsed.telemetry.uptimeSeconds).toBe('number');
      expect(typeof parsed.telemetry.cpuPercent).toBe('number');
      expect(parsed.telemetry.cpuPercent).toBeGreaterThanOrEqual(0);
      expect(parsed.telemetry.messagesPerMinute).toBe(0);
      expect(parsed.telemetry.errorCount).toBe(0);
      expect(parsed.telemetry.health).toBe('good');
    });

    it('counts recent messagesPerMinute and errorCount from outbox state', async () => {
      const ctx = new CliContext(tempDir);
      const settings = ctx.getSettings();
      settings.sinks['archive'] = {
        type: 'archive',
        enabled: true,
        config: { directory: path.join(tempDir, 'archive') },
      };
      ctx.saveSettings(settings);

      const outbox = ctx.getOutbox();
      await outbox.enqueue(makeSyntheticMessage(1), ['archive']);
      await outbox.enqueue(makeSyntheticMessage(2), ['archive']);
      const pending = await outbox.getPendingDeliveries('archive', 10);
      await outbox.markFailed(pending[0]!.deliveryId, 'Simulated transient write error');
      outbox.close();
      ctx.close();

      const result = await executeCli(['status', '--json'], { dataDir: tempDir });
      expect(result.exitCode).toBe(0);

      const parsed = JSON.parse(result.stdout);
      expect(parsed.telemetry.messagesPerMinute).toBe(2);
      expect(parsed.telemetry.errorCount).toBe(1);
    });

    it('exports named threshold constants for health classification', () => {
      expect(typeof SLOW_QUEUE_THRESHOLD).toBe('number');
      expect(SLOW_QUEUE_THRESHOLD).toBeGreaterThan(0);

      expect(typeof SLOW_CPU_PERCENT_THRESHOLD).toBe('number');
      expect(typeof PROBLEM_CPU_PERCENT_THRESHOLD).toBe('number');
      expect(SLOW_CPU_PERCENT_THRESHOLD).toBeGreaterThan(0);
      expect(PROBLEM_CPU_PERCENT_THRESHOLD).toBeGreaterThan(SLOW_CPU_PERCENT_THRESHOLD);

      expect(typeof SLOW_MEMORY_MB_THRESHOLD).toBe('number');
      expect(typeof PROBLEM_MEMORY_MB_THRESHOLD).toBe('number');
      expect(SLOW_MEMORY_MB_THRESHOLD).toBeGreaterThan(0);
      expect(PROBLEM_MEMORY_MB_THRESHOLD).toBeGreaterThan(SLOW_MEMORY_MB_THRESHOLD);

      expect(typeof PROBLEM_ERROR_COUNT_THRESHOLD).toBe('number');
      expect(PROBLEM_ERROR_COUNT_THRESHOLD).toBeGreaterThan(0);
    });

    it('evaluates unit health verdicts for good, slow, and problem states', () => {
      expect(
        evaluateAppHealth({
          sinks: {
            archive: { health: 'ok', reason: 'Active' },
          },
          outbox: {
            archive: {
              pendingCount: SLOW_QUEUE_THRESHOLD,
              inFlightCount: 0,
              deadLetterCount: 0,
            },
          },
          cpuPercent: SLOW_CPU_PERCENT_THRESHOLD - 1,
          memoryUsageMb: SLOW_MEMORY_MB_THRESHOLD - 10,
          errorCount: 0,
        })
      ).toBe('good');

      // Slow when any sink is degraded
      expect(
        evaluateAppHealth({
          sinks: {
            archive: { health: 'ok', reason: 'Active' },
            margince: { health: 'degraded', reason: 'Rate limited' },
          },
          outbox: {},
          cpuPercent: 1,
          memoryUsageMb: 50,
          errorCount: 0,
        })
      ).toBe('slow');

      // Slow when queue keeps growing past SLOW_QUEUE_THRESHOLD
      expect(
        evaluateAppHealth({
          sinks: {
            archive: { health: 'ok', reason: 'Active' },
          },
          outbox: {
            archive: {
              pendingCount: SLOW_QUEUE_THRESHOLD + 1,
              inFlightCount: 0,
              deadLetterCount: 0,
            },
          },
          cpuPercent: 1,
          memoryUsageMb: 50,
          errorCount: 0,
        })
      ).toBe('slow');

      // Slow when CPU or memory crosses slow threshold
      expect(
        evaluateAppHealth({
          sinks: { archive: { health: 'ok', reason: 'Active' } },
          outbox: {},
          cpuPercent: SLOW_CPU_PERCENT_THRESHOLD,
          memoryUsageMb: 50,
          errorCount: 0,
        })
      ).toBe('slow');

      expect(
        evaluateAppHealth({
          sinks: { archive: { health: 'ok', reason: 'Active' } },
          outbox: {},
          cpuPercent: 1,
          memoryUsageMb: SLOW_MEMORY_MB_THRESHOLD,
          errorCount: 0,
        })
      ).toBe('slow');

      // Problem when any sink is down (even if another sink is degraded or queue is growing)
      expect(
        evaluateAppHealth({
          sinks: {
            archive: { health: 'degraded', reason: 'Paused' },
            margince: { health: 'down', reason: 'Endpoint unreachable' },
          },
          outbox: {
            archive: {
              pendingCount: SLOW_QUEUE_THRESHOLD + 50,
              inFlightCount: 0,
              deadLetterCount: 0,
            },
          },
          cpuPercent: 1,
          memoryUsageMb: 50,
          errorCount: 0,
        })
      ).toBe('problem');

      // Problem when CPU, memory, or errorCount crosses problem threshold
      expect(
        evaluateAppHealth({
          sinks: { archive: { health: 'ok', reason: 'Active' } },
          outbox: {},
          cpuPercent: PROBLEM_CPU_PERCENT_THRESHOLD + 1,
          memoryUsageMb: 50,
          errorCount: 0,
        })
      ).toBe('problem');

      expect(
        evaluateAppHealth({
          sinks: { archive: { health: 'ok', reason: 'Active' } },
          outbox: {},
          cpuPercent: 1,
          memoryUsageMb: PROBLEM_MEMORY_MB_THRESHOLD + 1,
          errorCount: 0,
        })
      ).toBe('problem');

      expect(
        evaluateAppHealth({
          sinks: { archive: { health: 'ok', reason: 'Active' } },
          outbox: {},
          cpuPercent: 1,
          memoryUsageMb: 50,
          errorCount: PROBLEM_ERROR_COUNT_THRESHOLD,
        })
      ).toBe('problem');
    });

    it('prints one plain "App health: <verdict>" line for good, slow, and problem verdicts', async () => {
      // 1. Good verdict on healthy system
      const goodPlain = await executeCli(['status'], { dataDir: tempDir });
      expect(goodPlain.exitCode).toBe(0);
      const goodHealthLines = goodPlain.stdout
        .split('\n')
        .filter((line) => line.startsWith('App health:'));
      expect(goodHealthLines).toEqual(['App health: good']);

      // 2. Slow verdict when a sink is degraded
      const ctxSlow = new CliContext(tempDir);
      const slowSettings = ctxSlow.getSettings();
      slowSettings.sinks['archive'] = {
        type: 'archive',
        enabled: false,
        config: { directory: path.join(tempDir, 'archive') },
      };
      ctxSlow.saveSettings(slowSettings);
      ctxSlow.close();

      const slowPlain = await executeCli(['status'], { dataDir: tempDir });
      expect(slowPlain.exitCode).toBe(0);
      const slowHealthLines = slowPlain.stdout
        .split('\n')
        .filter((line) => line.startsWith('App health:'));
      expect(slowHealthLines).toEqual(['App health: slow']);

      const slowJson = await executeCli(['status', '--json'], { dataDir: tempDir });
      expect(JSON.parse(slowJson.stdout).telemetry.health).toBe('slow');

      // 3. Slow verdict when queue keeps growing past threshold on an active sink
      const ctxGrowing = new CliContext(tempDir);
      const growingSettings = ctxGrowing.getSettings();
      growingSettings.sinks['archive'] = {
        type: 'archive',
        enabled: true,
        config: { directory: path.join(tempDir, 'archive') },
      };
      ctxGrowing.saveSettings(growingSettings);
      const outboxGrowing = ctxGrowing.getOutbox();
      const targetQueueCount = (SLOW_QUEUE_THRESHOLD ?? 100) + 1;
      for (let i = 1; i <= targetQueueCount; i++) {
        await outboxGrowing.enqueue(makeSyntheticMessage(i), ['archive']);
      }
      outboxGrowing.close();
      ctxGrowing.close();

      const growingJson = await executeCli(['status', '--json'], { dataDir: tempDir });
      expect(JSON.parse(growingJson.stdout).telemetry.health).toBe('slow');

      // 4. Problem verdict when a sink is down (permanent delivery refusal / down state)
      const ctxProblem = new CliContext(tempDir);
      const problemSettings = ctxProblem.getSettings();
      problemSettings.sinks['archive'] = {
        type: 'archive',
        enabled: true,
        config: { directory: path.join(tempDir, 'archive'), health: 'down' },
      };
      ctxProblem.saveSettings(problemSettings);
      const outboxProblem = ctxProblem.getOutbox();
      const pendingDeliveries = await outboxProblem.getPendingDeliveries('archive', 1);
      if (pendingDeliveries[0]) {
        await outboxProblem.markRefused(
          pendingDeliveries[0].deliveryId,
          'Destination permanently unreachable'
        );
      }
      outboxProblem.close();
      ctxProblem.close();

      const problemPlain = await executeCli(['status'], { dataDir: tempDir });
      expect(problemPlain.exitCode).toBe(0);
      const problemHealthLines = problemPlain.stdout
        .split('\n')
        .filter((line) => line.startsWith('App health:'));
      expect(problemHealthLines).toEqual(['App health: problem']);

      const problemJson = await executeCli(['status', '--json'], { dataDir: tempDir });
      expect(JSON.parse(problemJson.stdout).telemetry.health).toBe('problem');
    });
  });
});
