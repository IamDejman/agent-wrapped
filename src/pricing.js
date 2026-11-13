/**
 * Published API list prices in USD per million tokens, checked 2026-11-13:
 *   [model id, input, output, cache read, cache write (5 minutes), cache write (1 hour)]
 * First match wins, so a newer version sits above the one its id starts with.
 * Base rates only: long-prompt surcharges are ignored, and a model with no
 * published rate stays unpriced, so the total is a floor rather than a guess.
 *
 *   https://platform.claude.com/docs/en/about-claude/pricing
 *   https://aistudio.google.com/docs/pricing
 *   https://developers.openai.com/api/docs/pricing
 *   https://docs.x.ai/docs/models
 */
const RATES = [
  [/^claude-(fable|mythos)-5-2/, 8, 40, 0.2, 10, 16],
  [/^claude-(fable|mythos)-5-1/, 10, 50, 0.25, 12.5, 20],
  [/^claude-(fable|mythos)-5/, 10, 50, 1, 12.5, 20],
  [/^claude-opus-5-5/, 4, 20, 0.2, 5, 8],
  [/^claude-opus-(5|4-[5-8])/, 5, 25, 0.5, 6.25, 10],
  [/^claude-sonnet-5-5/, 2, 10, 0.1, 2.5, 4],
  [/^claude-sonnet-5/, 2, 10, 0.2, 2.5, 4],
  [/^claude-sonnet-4/, 3, 15, 0.3, 3.75, 6],
  [/^claude-haiku-5-5/, 0.1, 0.5, 0.01, 0.125, 0.2],
  [/^claude-haiku-4-5/, 1, 5, 0.1, 1.25, 2],
  [/^gemini-4-(argon|carbon)/, 2, 10, 0.1],
  [/^gemini-3\.[68]-flash/, 0.75, 3.75, 0.075],
  [/^gpt-6\.1-sol/, 2, 10, 0.1],
  [/^gpt-6-astra/, 10, 50, 1],
  [/^gpt-6-sol/, 2, 10, 0.2],
  [/^gpt-6-luna/, 0.1, 0.5, 0.01],
  [/^gpt-5\.6-sol/, 4, 20, 0.4],
  [/^gpt-5\.6-terra/, 2, 12, 0.2],
  [/^gpt-5\.6-luna/, 0.2, 1.2, 0.02],
  [/^gpt-5\.5$/, 5, 30, 0.5],
  [/^gpt-5\.4$/, 2.5, 15, 0.25],
  [/^grok-4\.[67]/, 2, 6, 0.5],
  [/^grok-4\.5/, 2, 6, 0.3],
];

/**
 * What a reply would have cost on the model's own API, and what prompt caching
 * took off that bill: cached reads priced as plain input, minus the premium
 * paid to write the cache. Null when the model has no published rate.
 */
export function price(ev) {
  const rate = ev.model && RATES.find(([id]) => id.test(ev.model));
  if (!rate) return null;
  const [, input, output, cacheRead, write = input, write1h = write] = rate;
  const slow = ev.cacheWrite1h || 0;
  const fast = ev.cacheWrite - slow;
  return {
    usd: (ev.in * input + ev.out * output + ev.cacheRead * cacheRead + fast * write + slow * write1h) / 1e6,
    saved: (ev.cacheRead * (input - cacheRead) - fast * (write - input) - slow * (write1h - input)) / 1e6,
  };
}
