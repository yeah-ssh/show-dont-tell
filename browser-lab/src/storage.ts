import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { config } from './config.js';

/** Publishes an evidence file and returns a URL a human can open. */
export async function publish(localPath: string, remoteName: string): Promise<string> {
  if (config.evidenceStore === 'local') {
    return `http://${config.host}:${config.port}/evidence/${remoteName}`;
  }
  return publishToGitHub(localPath, remoteName);
}

async function publishToGitHub(localPath: string, remoteName: string): Promise<string> {
  if (!config.githubToken) throw new Error('EVIDENCE_STORE=github needs GITHUB_TOKEN (or `gh auth login`)');
  const [owner, repo] = config.evidenceRepo.split('/');
  const content = (await readFile(localPath)).toString('base64');
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${remoteName}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${config.githubToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({
      message: `evidence: ${basename(remoteName)}`,
      content,
      branch: config.evidenceBranch,
    }),
  });
  if (!res.ok) throw new Error(`GitHub upload failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  return `https://raw.githubusercontent.com/${owner}/${repo}/${config.evidenceBranch}/${remoteName}`;
}

/** Browser-viewable page for a file (GitHub renders a player for mp4 in the blob view). */
export function viewerUrl(rawUrl: string): string {
  const m = rawUrl.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
  return m ? `https://github.com/${m[1]}/${m[2]}/blob/${m[3]}/${m[4]}` : rawUrl;
}
