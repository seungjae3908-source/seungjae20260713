import { appendFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const OWNER_LOGIN = 'seungjae3908-source';

export function parseStagingPostgresAuthCommand(raw) {
  const body = String(raw ?? '').trim();
  const match = /^\/run-staging-auth(-only)? ([0-9a-fA-F]{40})$/.exec(body);
  if (!match) {
    throw new Error(
      'Exact command required: /run-staging-auth <40-character-current-main-sha> or '
      + '/run-staging-auth-only <40-character-current-main-sha>',
    );
  }
  return {
    mode: match[1] === '-only' ? 'auth-only' : 'staging',
    sha: match[2].toLowerCase(),
  };
}

export function requireRepositoryOwner(login, association) {
  if (String(login ?? '').trim() !== OWNER_LOGIN) {
    throw new Error('Only the repository owner may run the staging database authentication gate.');
  }
  if (String(association ?? '').trim() !== 'OWNER') {
    throw new Error('Command author is not the repository owner.');
  }
}

export function writeCommandOutputs(outputPath, command) {
  if (!outputPath) throw new Error('GITHUB_OUTPUT is required');
  appendFileSync(outputPath, `sha=${command.sha}\nmode=${command.mode}\n`);
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  try {
    requireRepositoryOwner(process.env.COMMENT_AUTHOR, process.env.AUTHOR_ASSOCIATION);
    writeCommandOutputs(
      process.env.GITHUB_OUTPUT,
      parseStagingPostgresAuthCommand(process.env.COMMENT_BODY),
    );
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : 'Staging authentication command rejected.');
    process.exitCode = 1;
  }
}
