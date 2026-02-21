import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { MergeResult } from './types.js';

function resolveGitDir(gitCwd: string): string {
  const gitDir = execSync('git rev-parse --git-dir', {
    encoding: 'utf-8',
    cwd: gitCwd,
  }).trim();

  return path.isAbsolute(gitDir) ? gitDir : path.join(gitCwd, gitDir);
}

export function isGitRepo(gitCwd: string = process.cwd()): boolean {
  try {
    execSync('git rev-parse --git-dir', { stdio: 'pipe', cwd: gitCwd });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run git merge-file to three-way merge files.
 * Modifies currentPath in-place.
 * Returns { clean: true, exitCode: 0 } on clean merge,
 * { clean: false, exitCode: N } on conflict (N = number of conflicts).
 */
export function mergeFile(
  currentPath: string,
  basePath: string,
  skillPath: string,
): MergeResult {
  try {
    execFileSync('git', ['merge-file', currentPath, basePath, skillPath], {
      stdio: 'pipe',
    });
    return { clean: true, exitCode: 0 };
  } catch (err: any) {
    const exitCode = err.status ?? 1;
    if (exitCode > 0) {
      // Positive exit code = number of conflicts
      return { clean: false, exitCode };
    }
    // Negative exit code = error
    throw new Error(`git merge-file failed: ${err.message}`);
  }
}

/**
 * Set up unmerged index entries for rerere adapter.
 * Creates stages 1/2/3 so git rerere can record/resolve conflicts.
 */
export function setupRerereAdapter(
  filePath: string,
  baseContent: string,
  oursContent: string,
  theirsContent: string,
  gitCwd: string = process.cwd(),
): void {
  if (!isGitRepo(gitCwd)) return;

  const gitDir = resolveGitDir(gitCwd);

  // Clean up stale MERGE_HEAD from a previous crash
  if (fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))) {
    cleanupMergeState(filePath, gitCwd);
  }

  // Hash objects into git object store
  const baseHash = execSync('git hash-object -w --stdin', {
    input: baseContent,
    encoding: 'utf-8',
    cwd: gitCwd,
  }).trim();
  const oursHash = execSync('git hash-object -w --stdin', {
    input: oursContent,
    encoding: 'utf-8',
    cwd: gitCwd,
  }).trim();
  const theirsHash = execSync('git hash-object -w --stdin', {
    input: theirsContent,
    encoding: 'utf-8',
    cwd: gitCwd,
  }).trim();

  // Create unmerged index entries (stages 1/2/3)
  const indexInfo = [
    `100644 ${baseHash} 1\t${filePath}`,
    `100644 ${oursHash} 2\t${filePath}`,
    `100644 ${theirsHash} 3\t${filePath}`,
  ].join('\n');

  execSync('git update-index --index-info', {
    input: indexInfo,
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: gitCwd,
  });

  // Set MERGE_HEAD and MERGE_MSG (required for rerere)
  const headHash = execSync('git rev-parse HEAD', {
    encoding: 'utf-8',
    cwd: gitCwd,
  }).trim();
  fs.writeFileSync(path.join(gitDir, 'MERGE_HEAD'), headHash + '\n');
  fs.writeFileSync(
    path.join(gitDir, 'MERGE_MSG'),
    `Skill merge: ${filePath}\n`,
  );
}

/**
 * Run git rerere to record or auto-resolve conflicts.
 * When filePath is given, checks that specific file for remaining conflict markers.
 * Returns true if rerere auto-resolved the conflict.
 */
export function runRerere(
  filePath: string,
  gitCwd: string = process.cwd(),
): boolean {
  if (!isGitRepo(gitCwd)) return false;

  try {
    execSync('git rerere', { stdio: 'pipe', cwd: gitCwd });

    // Check if the specific working tree file still has conflict markers.
    // rerere resolves the working tree but does NOT update the index,
    // so checking unmerged index entries would give a false negative.
    const content = fs.readFileSync(filePath, 'utf-8');
    return !content.includes('<<<<<<<');
  } catch {
    return false;
  }
}

/**
 * Clean up merge state after rerere operations.
 * Pass filePath to only reset that file's index entries (preserving user's staged changes).
 */
export function cleanupMergeState(
  filePath?: string,
  gitCwd: string = process.cwd(),
): void {
  if (!isGitRepo(gitCwd)) return;

  const gitDir = resolveGitDir(gitCwd);

  // Remove merge markers
  const mergeHead = path.join(gitDir, 'MERGE_HEAD');
  const mergeMsg = path.join(gitDir, 'MERGE_MSG');
  if (fs.existsSync(mergeHead)) fs.unlinkSync(mergeHead);
  if (fs.existsSync(mergeMsg)) fs.unlinkSync(mergeMsg);

  // Reset only the specific file's unmerged index entries to avoid
  // dropping the user's pre-existing staged changes
  try {
    if (filePath) {
      execFileSync('git', ['reset', '--', filePath], {
        stdio: 'pipe',
        cwd: gitCwd,
      });
    } else {
      execSync('git reset', { stdio: 'pipe', cwd: gitCwd });
    }
  } catch {
    // May fail if nothing staged
  }
}
