import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';

export type ReplyInput = {
  issue_id: string;
  to_email: string;
  subject: string;
  body_markdown: string;
  evidence_urls: string[];
};

function markdownToHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc(md)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2" style="max-width:100%">')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .split(/\n{2,}/)
    .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

async function sendEmail(input: ReplyInput): Promise<string> {
  if (!config.resendApiKey) return 'skipped (no RESEND_API_KEY; saved to outbox only)';
  const to = config.replyOverrideTo || input.to_email;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.replyFrom, to: [to], subject: input.subject, html: markdownToHtml(input.body_markdown) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Resend failed (${res.status}): ${text.slice(0, 300)}`);
  return `sent to ${to} (${JSON.parse(text).id})`;
}

async function postLinearComment(input: ReplyInput): Promise<string> {
  if (!config.linearApiKey) return 'skipped (no LINEAR_API_KEY)';
  const query = `
    mutation($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) { success comment { url } }
    }`;
  const body = `**Reply sent to customer** (${input.to_email})\n\n---\n\n${input.body_markdown}`;
  const res = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: { Authorization: config.linearApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { issueId: input.issue_id, body } }),
  });
  const json = (await res.json()) as { data?: { commentCreate?: { comment?: { url?: string } } }; errors?: unknown };
  if (json.errors) throw new Error(`Linear failed: ${JSON.stringify(json.errors).slice(0, 300)}`);
  return `commented ${json.data?.commentCreate?.comment?.url ?? ''}`;
}

/** The irreversible action. Only reachable after a human approves it in TrueForge. */
export async function sendCustomerReply(input: ReplyInput) {
  await mkdir(config.dataDir, { recursive: true });
  const email = await sendEmail(input);
  const linear = await postLinearComment(input);
  const record = { at: new Date().toISOString(), ...input, email, linear };
  await appendFile(join(config.dataDir, 'outbox.jsonl'), `${JSON.stringify(record)}\n`);
  return { email, linear };
}
