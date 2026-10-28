import assert from 'node:assert';
import { hasPlayableQueue } from './ResumeState';

const track = { encoded: 'encodedA', info: {} } as never;

// 1. A current track or upcoming tracks are resumable.
assert.strictEqual(hasPlayableQueue({ current: track, tracks: [], previous: [] }), true);
assert.strictEqual(hasPlayableQueue({ current: null, tracks: [track], previous: [] }), true);

// 2. A stopped or finished queue (idle snapshot) has nothing to resume.
assert.strictEqual(hasPlayableQueue({ current: null, tracks: [], previous: [track] }), false);
assert.strictEqual(hasPlayableQueue({}), false);

// 3. No saved queue at all: unknown, caller keeps the old behaviour.
assert.strictEqual(hasPlayableQueue(undefined), undefined);
assert.strictEqual(hasPlayableQueue(null), undefined);

console.log('ResumeState.spec: all assertions passed');
