import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { anthropicPick, loadPickPrompt } from '../../src/harvest/anthropic-picker.js';
import { PickerResponseError } from '../../src/harvest/picker.js';
import type { RecordUsage } from '../../src/lib/usage.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

const message = (text: string, stopReason = 'end_turn') => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5',
  content: [{ type: 'text', text }],
  stop_reason: stopReason,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
});

/** A real HTTP server on 127.0.0.1:0 standing in for the Messages API. Replies with replies[n], repeating the last. */
async function fakeApi(replies: { status: number; body: unknown }[]) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')));
    req.on('end', () => {
      requests.push(JSON.parse(data) as Record<string, unknown>);
      const reply = replies[Math.min(requests.length, replies.length) - 1]!;
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const client = new Anthropic({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${port}`, maxRetries: 0 });
  return { client, requests };
}

describe('anthropicPick', () => {
  it('sends the model, the prompts and a JSON schema format, and returns the parsed answer', async () => {
    const { client, requests } = await fakeApi([{ status: 200, body: message('{"picks":[{"id":2,"reason":"stands alone"}]}') }]);
    expect(await anthropicPick(client, 'claude-sonnet-5')('system prompt', 'user message')).toEqual({
      picks: [{ id: 2, reason: 'stands alone' }],
    });
    expect(requests[0]).toMatchObject({
      model: 'claude-sonnet-5',
      system: 'system prompt',
      messages: [{ role: 'user', content: 'user message' }],
      output_config: { format: { type: 'json_schema', schema: { type: 'object' } }, effort: 'low' },
    });
  });

  it('turns an answer that is not JSON, or a refusal, into a PickerResponseError', async () => {
    const { client } = await fakeApi([
      { status: 200, body: message('Here are my picks: 2') },
      { status: 200, body: message('', 'refusal') },
    ]);
    const pick = anthropicPick(client, 'claude-sonnet-5');
    await expect(pick('s', 'u')).rejects.toThrow(PickerResponseError);
    await expect(pick('s', 'u')).rejects.toThrow(PickerResponseError);
  });

  it('lets API errors through so the run stops', async () => {
    const { client } = await fakeApi([
      { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } },
    ]);
    await expect(anthropicPick(client, 'claude-sonnet-5')('s', 'u')).rejects.toThrow(Anthropic.AuthenticationError);
  });

  it('lets a failure to build the request through, so a missing key never reads as nothing quotable', async () => {
    const broken = {
      messages: {
        create: () => Promise.reject(new Error('Could not resolve authentication method')),
      },
    } as unknown as Anthropic;
    const rejection = anthropicPick(broken, 'claude-sonnet-5')('s', 'u');
    await expect(rejection).rejects.toThrow('Could not resolve authentication method');
    await expect(rejection).rejects.not.toBeInstanceOf(PickerResponseError);
  });

  it('loads the committed picker prompt', () => {
    expect(loadPickPrompt(ROOT)).toContain('You can only choose by number.');
  });
});

describe('anthropicPick usage recording', () => {
  it('records every batch under its book, including one whose answer is unusable', async () => {
    const { client } = await fakeApi([{ status: 200, body: message('{"picks":[]}') }, { status: 200, body: message('', 'refusal') }]);
    const calls: Parameters<RecordUsage>[] = [];
    const pick = anthropicPick(client, 'claude-sonnet-5', (tag, usage) => void calls.push([tag, usage]));
    await pick('s', 'u', { stage: 'harvest', gutenbergId: 46 });
    await expect(pick('s', 'u', { stage: 'harvest', gutenbergId: 46 })).rejects.toThrow(PickerResponseError);
    expect(calls.map(([tag, usage]) => [tag, usage.inputTokens, usage.outputTokens, usage.stopReason])).toEqual([
      [{ stage: 'harvest', role: 'picker', gutenbergId: 46 }, 10, 5, 'end_turn'],
      [{ stage: 'harvest', role: 'picker', gutenbergId: 46 }, 10, 5, 'refusal'],
    ]);
  });
});
