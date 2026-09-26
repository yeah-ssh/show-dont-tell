import { readFile } from 'node:fs/promises';
import OpenAI from 'openai';
import { config } from './config.js';
import type { RunMeta } from './runs.js';

export type VisionVerdict = {
  bug_visible_before: boolean | null;
  fixed_after: boolean | null;
  confidence: number;
  notes: string;
  model: string;
};

/**
 * A second, independent check on top of the DOM assertion: a vision model looks at the
 * final screenshots and judges whether the described bug is visible. Routed through
 * OPENAI_BASE_URL, so it can go via the TrueFoundry AI Gateway.
 */
export async function verifyScreens(params: {
  expectation: string;
  before?: RunMeta;
  after?: RunMeta;
}): Promise<VisionVerdict> {
  if (!config.openaiApiKey) {
    return { bug_visible_before: null, fixed_after: null, confidence: 0, notes: 'Vision check skipped: no API key configured.', model: 'none' };
  }
  const client = new OpenAI({ apiKey: config.openaiApiKey, baseURL: config.openaiBaseUrl });
  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    {
      type: 'text',
      text:
        `You are verifying video evidence for a bug report.\n` +
        `Correct behaviour expected by the customer: ${params.expectation}\n` +
        `Judge only from the screenshots. Reply as JSON: ` +
        `{"bug_visible_before": bool|null, "fixed_after": bool|null, "confidence": 0..1, "notes": "one or two sentences"}. ` +
        `bug_visible_before = true when the BEFORE screenshot shows the app FAILING the expectation (the bug is present). ` +
        `fixed_after = true when the AFTER screenshot shows the app MEETING the expectation. ` +
        `Use null for a screenshot that was not provided.`,
    },
  ];
  for (const [name, run] of [['BEFORE (unpatched)', params.before], ['AFTER (patched)', params.after]] as const) {
    if (!run?.screenshot_path) continue;
    const b64 = (await readFile(run.screenshot_path)).toString('base64');
    content.push({ type: 'text', text: `${name}: ${run.browser} ${run.viewport.width}x${run.viewport.height}` });
    content.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${b64}`, detail: 'high' } });
  }
  const res = await client.chat.completions.create({
    model: config.visionModel,
    messages: [{ role: 'user', content }],
    response_format: { type: 'json_object' },
  });
  const parsed = JSON.parse(res.choices[0]?.message?.content || '{}');
  return {
    bug_visible_before: parsed.bug_visible_before ?? null,
    fixed_after: parsed.fixed_after ?? null,
    confidence: Number(parsed.confidence ?? 0),
    notes: String(parsed.notes ?? ''),
    model: res.model,
  };
}
