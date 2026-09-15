import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import {
  anthropicChecker,
  anthropicWriter,
  EnrichResponseError,
  enrichPromptPaths,
  FALLBACK_BETA,
  loadEnrichPrompts,
} from '../../src/enrich/anthropic.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

const message = (content: unknown[], stopReason = 'end_turn', model = 'claude-opus-5') => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model,
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  usage: { input_tokens: 1200, output_tokens: 300 },
});
const text = (value: string) => ({ type: 'text', text: value });

/** A real HTTP server on 127.0.0.1:0 standing in for the Messages API. Replies with replies[n], repeating the last. */
async function fakeApi(replies: { status: number; body: unknown }[]) {
  const requests: { url: string; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')));
    req.on('end', () => {
      requests.push({ url: req.url ?? '', headers: req.headers, body: JSON.parse(data) as Record<string, unknown> });
      const reply = replies[Math.min(requests.length, replies.length) - 1]!;
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { client: new Anthropic({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${port}`, maxRetries: 0 }), requests };
}

const DRAFT = '{"hook":{"text":"h","sources":["S1"]},"body":[],"closer":{"text":"c","sources":[]}}';

describe('anthropicWriter', () => {
  it('asks for a structured draft with server-side fallback, and returns the answer, model and token use', async () => {
    const { client, requests } = await fakeApi([{ status: 200, body: message([text(DRAFT)]) }]);
    expect(await anthropicWriter(client, 'claude-opus-5')('system prompt', 'user message')).toEqual({
      value: JSON.parse(DRAFT),
      model: 'claude-opus-5',
      inputTokens: 1200,
      outputTokens: 300,
    });
    expect(requests[0]!.headers['anthropic-beta']).toBe(FALLBACK_BETA);
    expect(requests[0]!.body).toMatchObject({
      model: 'claude-opus-5',
      fallbacks: 'default',
      max_tokens: 16000,
      system: 'system prompt',
      messages: [{ role: 'user', content: 'user message' }],
      output_config: { format: { type: 'json_schema', schema: { type: 'object' } }, effort: 'medium' },
    });
    expect(requests[0]!.body).not.toHaveProperty('betas');
  });

  it('reports the fallback model when a fallback wrote the answer', async () => {
    const fallback = { type: 'fallback', from: { model: 'claude-opus-5' }, to: { model: 'claude-sonnet-5' }, trigger: { type: 'refusal' } };
    const { client } = await fakeApi([{ status: 200, body: message([fallback, text(DRAFT)]) }]);
    expect((await anthropicWriter(client, 'claude-opus-5')('s', 'u')).model).toBe('claude-sonnet-5');
  });

  it('turns a refusal, a truncated answer or text that is not JSON into an EnrichResponseError', async () => {
    const { client } = await fakeApi([
      { status: 200, body: message([], 'refusal') },
      { status: 200, body: message([text('{"hook":')], 'max_tokens') },
      { status: 200, body: message([text('Here is a draft.')]) },
    ]);
    const write = anthropicWriter(client, 'claude-opus-5');
    await expect(write('s', 'u')).rejects.toThrow('the writer stopped with refusal and no usable output');
    await expect(write('s', 'u')).rejects.toThrow('the writer stopped with max_tokens and no usable output');
    await expect(write('s', 'u')).rejects.toThrow(EnrichResponseError);
  });

  it('lets API errors through so the run stops', async () => {
    const { client } = await fakeApi([{ status: 401, body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } }]);
    await expect(anthropicWriter(client, 'claude-opus-5')('s', 'u')).rejects.toThrow(Anthropic.AuthenticationError);
  });
});

describe('anthropicChecker', () => {
  it('asks for structured verdicts without the fallback beta, and returns the answer', async () => {
    const verdicts = '{"sentences":[{"id":1,"kind":"fact","supported":true,"sources":["S1"],"problem":""}]}';
    const { client, requests } = await fakeApi([
      { status: 200, body: message([text(verdicts)], 'end_turn', 'claude-sonnet-5') },
      { status: 200, body: message([text('not json')], 'end_turn', 'claude-sonnet-5') },
    ]);
    const check = anthropicChecker(client, 'claude-sonnet-5');
    expect(await check('check prompt', 'sentences')).toEqual({ value: JSON.parse(verdicts), model: 'claude-sonnet-5', inputTokens: 1200, outputTokens: 300 });
    expect(requests[0]!.headers['anthropic-beta']).toBeUndefined();
    expect(requests[0]!.body).toMatchObject({
      model: 'claude-sonnet-5',
      max_tokens: 16000,
      system: 'check prompt',
      output_config: { format: { type: 'json_schema' }, effort: 'medium' },
    });
    expect(requests[0]!.body).not.toHaveProperty('fallbacks');
    await expect(check('s', 'u')).rejects.toThrow("the fact check's output is not JSON");
  });
});

describe('enrich prompts', () => {
  it('loads the committed writer, reviser and fact-check prompts', () => {
    expect(enrichPromptPaths('literature')).toEqual({
      write: 'prompts/literature/enrich.md',
      revise: 'prompts/literature/revise.md',
      check: 'prompts/shared/fact-check.md',
    });
    const prompts = loadEnrichPrompts(ROOT, 'literature');
    expect(prompts.write).toContain('the source paragraphs are the only facts you have');
    expect(prompts.write).toContain('{{voice}}');
    expect(prompts.revise).toContain('{{body}}');
    expect(prompts.check).toContain('You have no other knowledge for this task.');
  });
});
