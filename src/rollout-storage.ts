import { constants } from 'node:fs';
import { access, copyFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';

export interface CodexRolloutResumeState {
  readonly rolloutPath?: string;
  readonly mirroredRolloutPath?: string;
  readonly rolloutRelativePath?: string;
  readonly mirroredRolloutFileName?: string;
}

interface CodexSessionMetadata {
  readonly rolloutRelativePath?: string;
  readonly mirroredRolloutFileName?: string;
  readonly sourceRolloutPath?: string;
  readonly mirroredRolloutPath?: string;
}

export async function restoreMirroredRolloutForResume(
  resumeState: CodexRolloutResumeState,
  sessionStoragePath: string,
  codexHome: string,
): Promise<string | undefined> {
  if (resumeState.rolloutPath && await fileExists(resumeState.rolloutPath)) {
    return undefined;
  }

  const metadata = await readCodexSessionMetadata(sessionStoragePath);
  const mirrorPath = await findMirroredRolloutPath(sessionStoragePath, metadata, resumeState);
  const destinationPath = restoreDestinationPath(codexHome, metadata, resumeState, mirrorPath);

  if (!mirrorPath || !destinationPath) {
    const nativePath = resumeState.rolloutPath ? ` at ${resumeState.rolloutPath}` : '';
    console.warn(`Codex rollout is missing${nativePath}; no mirrored rollout was found in ${sessionStoragePath}. Attempting thread/resume unchanged.`);
    return undefined;
  }

  await mkdir(dirname(destinationPath), { recursive: true });
  await copyFile(mirrorPath, destinationPath);
  return destinationPath;
}

export function relativeRolloutPath(rolloutPath: string | undefined, codexHome: string): string | undefined {
  if (!rolloutPath) {
    return undefined;
  }
  return safeRelativePath(relative(codexHome, rolloutPath));
}

export function resolveCodexHome(codexHome: string | undefined): string {
  return codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

async function readCodexSessionMetadata(sessionStoragePath: string): Promise<CodexSessionMetadata | undefined> {
  try {
    const value = JSON.parse(await readFile(join(sessionStoragePath, 'codex-session.json'), 'utf8')) as unknown;
    return typeof value === 'object' && value !== null ? value as CodexSessionMetadata : undefined;
  } catch (error) {
    if (isFileSystemNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function findMirroredRolloutPath(
  sessionStoragePath: string,
  metadata: CodexSessionMetadata | undefined,
  resumeState: CodexRolloutResumeState,
): Promise<string | undefined> {
  const candidates = [
    metadata?.mirroredRolloutFileName ? join(sessionStoragePath, metadata.mirroredRolloutFileName) : undefined,
    metadata?.mirroredRolloutPath ? join(sessionStoragePath, basename(metadata.mirroredRolloutPath)) : undefined,
    metadata?.sourceRolloutPath ? join(sessionStoragePath, basename(metadata.sourceRolloutPath)) : undefined,
    resumeState.mirroredRolloutFileName ? join(sessionStoragePath, resumeState.mirroredRolloutFileName) : undefined,
    resumeState.mirroredRolloutPath ? join(sessionStoragePath, basename(resumeState.mirroredRolloutPath)) : undefined,
    resumeState.rolloutPath ? join(sessionStoragePath, basename(resumeState.rolloutPath)) : undefined,
  ].filter((candidate): candidate is string => candidate !== undefined);

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function restoreDestinationPath(
  codexHome: string,
  metadata: CodexSessionMetadata | undefined,
  resumeState: CodexRolloutResumeState,
  mirrorPath: string | undefined,
): string | undefined {
  const relativePath = safeRelativePath(metadata?.rolloutRelativePath)
    ?? safeRelativePath(resumeState.rolloutRelativePath)
    ?? inferRolloutRelativePath(resumeState.rolloutPath)
    ?? inferRolloutRelativePath(metadata?.sourceRolloutPath)
    ?? inferRolloutRelativePath(mirrorPath);
  return relativePath ? join(codexHome, relativePath) : undefined;
}

function inferRolloutRelativePath(path: string | undefined): string | undefined {
  if (!path) {
    return undefined;
  }
  const normalized = normalize(path);
  const parts = normalized.split(/[\\/]+/);
  const sessionsIndex = parts.lastIndexOf('sessions');
  if (sessionsIndex >= 0 && sessionsIndex < parts.length - 1) {
    return safeRelativePath(parts.slice(sessionsIndex).join('/'));
  }

  const fileName = basename(path);
  const dateMatch = /^rollout-(\d{4})-(\d{2})-(\d{2})T/.exec(fileName);
  if (dateMatch) {
    return join('sessions', dateMatch[1] ?? '', dateMatch[2] ?? '', dateMatch[3] ?? '', fileName);
  }
  return join('sessions', fileName);
}

function safeRelativePath(path: string | undefined): string | undefined {
  if (!path || isAbsolute(path)) {
    return undefined;
  }
  const normalized = normalize(path);
  return normalized === '..' || normalized.startsWith(`..${sep}`)
    ? undefined
    : normalized;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (isFileSystemNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

function isFileSystemNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
