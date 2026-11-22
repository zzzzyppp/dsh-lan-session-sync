import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySessionBytes } from '../lib/session-files.js';
import { decide, mergeWorkspace, mergePackageJson, conflictName } from '../lib/merge.js';
import { syncSets } from '../lib/sets.js';
import { applyRemoteFile } from '../lib/filesync.js';
import { mergeCredentialRefs } from '../lib/credentials.js';

async function tempRoot() {
  return await mkdtemp(join(tmpdir(), 'lan-sync-'));
}

test('session logs append the remote tail when local bytes are a prefix', async () => {
  const root = await tempRoot();
  try {
    const file = join(root, 'session.v4.jsonl.zstd');
    await writeFile(file, Buffer.from('abc'));
    const first = await applySessionBytes({ absPath: file, data: Buffer.from('abcdef'), peerId: 'peer-a' });
    assert.equal(first.applied, 'appended');
    assert.equal(first.bytes, 3);
    assert.equal((await readFile(file)).toString(), 'abcdef');
    const again = await applySessionBytes({ absPath: file, data: Buffer.from('abcdef'), peerId: 'peer-a' });
    assert.equal(again.applied, 'unchanged');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('session logs never truncate a longer local log', async () => {
  const root = await tempRoot();
  try {
    const file = join(root, 'session.v4.jsonl.zstd');
    await writeFile(file, Buffer.from('abcdef'));
    const result = await applySessionBytes({ absPath: file, data: Buffer.from('abc'), peerId: 'peer-a' });
    assert.equal(result.applied, 'unchanged');
    assert.equal((await readFile(file)).toString(), 'abcdef');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a diverged session log is parked under conflicts and the local log is untouched', async () => {
  const root = await tempRoot();
  try {
    const file = join(root, 'session-1', 'session.v4.jsonl.zstd');
    await mkdir(join(root, 'session-1'), { recursive: true });
    await writeFile(file, Buffer.from('local-content'));
    const result = await applySessionBytes({ absPath: file, data: Buffer.from('remote-content'), peerId: 'peer-b' });
    assert.equal(result.applied, 'conflict');
    assert.match(result.conflictFile, /conflicts/);
    assert.equal((await readFile(file)).toString(), 'local-content');
    assert.equal((await readFile(result.conflictFile)).toString(), 'remote-content');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('decide implements the pull/merge/skip rules', () => {
  const local = { h: 'aaa', m: 10 };
  const remote = { h: 'bbb', m: 20 };
  assert.equal(decide({ local: null, remote, mode: 'lww', localDevice: 'a', remoteDevice: 'b' }).action, 'pull');
  assert.equal(decide({ local, remote: null, mode: 'lww', localDevice: 'a', remoteDevice: 'b' }).action, 'skip');
  assert.equal(decide({ local, remote: { ...remote, h: 'aaa' }, mode: 'lww', localDevice: 'a', remoteDevice: 'b' }).action, 'equal');
  assert.equal(decide({ local, remote, base: { h: 'aaa' }, mode: 'append', localDevice: 'a', remoteDevice: 'b' }).action, 'pull');
  assert.equal(decide({ local, remote: { ...remote, h: 'aaa' }, base: { h: 'aaa' }, mode: 'append', localDevice: 'a', remoteDevice: 'b' }).action, 'equal');
  assert.equal(decide({ local: { h: 'ccc', m: 9 }, remote, base: { h: 'aaa' }, mode: 'merge-workspace', localDevice: 'a', remoteDevice: 'b' }).action, 'merge');
  assert.equal(decide({ local: { h: 'aaa', m: 5 }, remote: { h: 'ccc', m: 9 }, base: { h: 'aaa' }, mode: 'lww', localDevice: 'a', remoteDevice: 'b' }).action, 'pull');
  assert.equal(decide({ local: { h: 'ccc', m: 9 }, remote: { h: 'aaa', m: 5 }, base: { h: 'aaa' }, mode: 'lww', localDevice: 'a', remoteDevice: 'b' }).action, 'skip');
});

test('passed conflict names keep the session directory', () => {
  const name = conflictName('session-1/session.v4.jsonl.zstd', 'peer-b', { now: 0, session: true });
  assert.match(name, /^session-1\/conflicts\/session\.v4\.jsonl\.zstd\.peer-b\./);
});

test('workspace merge unions sessions but keeps archive/pin flags local', () => {
  const local = {
    version: 2,
    global: { initialized: true, workspaceIds: ['w1'], archivedSessionIds: ['s1'], pinnedSessionIds: ['s1'] },
    tables: { workspaces: { w1: { id: 'w1', path: '/a', title: 'A', sessionIds: ['s1'], createdAt: 1, updatedAt: 5 } } },
  };
  const remote = {
    version: 2,
    global: { initialized: true, workspaceIds: ['w1', 'w2'], archivedSessionIds: ['s2'], pinnedSessionIds: ['s2'] },
    tables: { workspaces: { w1: { id: 'w1', path: '/a2', title: 'A2', sessionIds: ['s2'], createdAt: 2, updatedAt: 9 } } },
  };
  const merged = mergeWorkspace(local, remote);
  assert.deepEqual(merged.value.global.workspaceIds, ['w1', 'w2']);
  assert.deepEqual(merged.value.global.archivedSessionIds, ['s1']);
  assert.deepEqual(merged.value.global.pinnedSessionIds, ['s1']);
  assert.deepEqual(merged.value.tables.workspaces.w1.sessionIds, ['s1', 's2']);
  assert.equal(merged.value.tables.workspaces.w1.updatedAt, 9);
});

test('profile merge adds remote bundles only when resolvable', () => {
  const local = { dependencies: { a: '1' }, dsh: { profile: { bundles: ['a'] } } };
  const remote = { dependencies: { a: '2', b: '3', 'link:x': 'link:../x' }, dsh: { profile: { bundles: ['b', 'c'] } } };
  const merged = mergePackageJson(local, remote, {
    resolveBundle: (name) => name === 'b',
    linkTargetExists: () => false,
  });
  assert.equal(merged.value.dependencies.a, '1');
  assert.equal(merged.value.dependencies.b, '3');
  assert.equal(merged.value.dependencies['link:x'], undefined);
  assert.deepEqual(merged.value.dsh.profile.bundles, ['a', 'b']);
});

test('pushMode never overwrites a differing local file', async () => {
  const home = await tempRoot();
  try {
    const set = { id: 'attachments', root: join(home, 'attachments'), mode: 'lww', include: null, exclude: null, deletesEnabled: true };
    await mkdir(set.root, { recursive: true });
    const rel = 'note.txt';
    await writeFile(join(set.root, rel), 'local');
    const result = await applyRemoteFile({
      set,
      rel,
      data: Buffer.from('remote'),
      entry: { h: 'remote-hash', s: 6, m: 10 },
      peer: 'peer-x',
      localEntry: { h: 'local-hash', s: 5, m: 5 },
      pushMode: true,
    });
    assert.equal(result.applied, 'conflict');
    assert.equal((await readFile(join(set.root, rel))).toString(), 'local');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('credentials merge only API_KEY refs and keeps local values on conflict', () => {
  const local = 'version: 1\nrecords: {}\nrefs:\n  OPENAI_API_KEY: local-value\n  OTHER: keep\n';
  const remote = 'version: 1\nrecords: {}\nrefs:\n  OPENAI_API_KEY: remote-value\n  ANTHROPIC_API_KEY: new-value\n  OTHER: changed\n';
  const merged = mergeCredentialRefs(local, remote);
  assert.match(merged.text, /OPENAI_API_KEY: local-value/);
  assert.match(merged.text, /ANTHROPIC_API_KEY: new-value/);
  assert.match(merged.text, /OTHER: keep/);
});

test('syncSets includes every reference set with cache off by default', () => {
  const home = '/tmp/lan-sync-does-not-exist';
  const sets = syncSets({ home, profile: 'desktop' });
  const ids = sets.map((set) => set.id);
  for (const id of ['sessions', 'workspace', 'storages', 'profile', 'modules', 'credentials', 'attachments']) {
    assert.ok(ids.includes(id), `missing set ${id}`);
  }
  assert.equal(ids.includes('cache'), false);
});
