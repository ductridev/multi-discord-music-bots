import assert from 'node:assert';
import { isTrackLoopReplay } from './TrackLoop';

// 1. Track loop replaying the same track — the one case that reuses the message.
{
	assert.strictEqual(isTrackLoopReplay('track', 'encodedA', 'encodedA'), true);
}

// 2. Skip while looping: lavalink-client advanced the queue, so the track differs
//    even though repeatMode is still 'track'. This is the stuck-embed bug.
{
	assert.strictEqual(isTrackLoopReplay('track', 'encodedB', 'encodedA'), false);
}

// 3. No previous track recorded (first track of a session) — post a message.
{
	assert.strictEqual(isTrackLoopReplay('track', 'encodedA', undefined), false);
}

// 4. Queue loop and loop-off never reuse the message, same track or not.
{
	assert.strictEqual(isTrackLoopReplay('queue', 'encodedA', 'encodedA'), false);
	assert.strictEqual(isTrackLoopReplay('off', 'encodedA', 'encodedA'), false);
}

// 5. Missing current track (trackEnd with a null track) falls through to replace.
{
	assert.strictEqual(isTrackLoopReplay('track', undefined, undefined), false);
	assert.strictEqual(isTrackLoopReplay('track', null, null), false);
}

console.log('TrackLoop: all assertions passed');
