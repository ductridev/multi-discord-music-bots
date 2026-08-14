/**
 * Whether the player is replaying the *same* track under track-loop mode.
 *
 * `repeatMode === 'track'` alone is not enough: `Player.skip()` sets
 * `internal_skipped`, which makes lavalink-client advance the queue even in
 * track-loop mode. So a skip while looping keeps `repeatMode === 'track'` but
 * plays a different track, and the now-playing message must be replaced
 * instead of reused.
 */
export function isTrackLoopReplay(
	repeatMode: string,
	currentEncoded?: string | null,
	previousEncoded?: string | null,
): boolean {
	return repeatMode === 'track' && !!currentEncoded && currentEncoded === previousEncoded;
}
