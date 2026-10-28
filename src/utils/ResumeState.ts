import type { StoredQueue } from 'lavalink-client';

/**
 * Whether a saved queue has anything for the resume fallback to replay.
 *
 * Returns `undefined` when no queue was saved at all, so callers can keep the
 * previous behaviour for data written before queues were persisted.
 */
export function hasPlayableQueue(queue?: Partial<StoredQueue> | null): boolean | undefined {
	if (!queue) return undefined;
	return !!queue.current || (queue.tracks?.length ?? 0) > 0;
}
