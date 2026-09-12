export declare const TRENDING_RELAY: string;
export declare const WINE_TRENDING_API: string;
export declare const WINE_TRENDING_LIMIT: number;
export declare const TRENDING_FEED_NOTE_LIMIT: number;
export declare const RELAY_ALIGNED_TRENDING_HOURS: 48;
export declare const WINE_MIN_REQUEST_INTERVAL_MS: number;

export declare const EVENT_HYDRATION_RELAYS: readonly string[];
export declare const ENGAGEMENT_RELAYS: readonly string[];
export declare const ENGAGEMENT_BACKFILL_MAX: number;
export declare const ENGAGEMENT_ID_CHUNK_SIZE: number;
export declare const ENGAGEMENT_QUERY_LIMIT: number;

export declare const VERTEX_PROFILE_RELAY: string;
export declare const FALLBACK_PROFILE_RELAYS: readonly string[];
export declare const PROFILE_RELAYS: readonly string[];
export declare const VERTEX_PROFILE_AUTHOR_CHUNK: number;

export declare const RELAY_MAX_WAIT_MS: number;
export declare const TRENDING_FETCH_ATTEMPTS: number;

export declare const RANK_WEIGHT_REACTIONS: number;
export declare const RANK_WEIGHT_REPLIES: number;
export declare const RANK_WEIGHT_REPOSTS: number;
export declare const RANK_ZAP_LOG_SCALE: number;
export declare const RANK_AGE_OFFSET_HOURS: number;
export declare const RANK_GRAVITY: number;
export declare const RANK_MISSING_VERTEX_PROFILE_FACTOR: number;
export declare const RANK_EXCESS_HASHTAG_FACTOR: number;
export declare const RANK_EXCESS_HTTP_LINK_FACTOR: number;
export declare const RANK_DOWNRANKED_LINK_HOST_FACTOR: number;

export declare function chunkArray<T>(array: T[], chunkSize: number): T[][];

export type NoteEngagement = {
  reactions: number;
  replies: number;
  reposts: number;
  zapAmount: number;
};

export type TrendingScoreOptions = {
  vertexProfilePubkeys?: Set<string> | null;
};

export type RankTrendingNotesOptions = TrendingScoreOptions & {
  nowSec?: number;
};

export declare function excessHashtagRankFactor(hashtagCount: number): number;

export declare function excessHttpLinkRankFactor(linkCount: number): number;

export declare function scoreTrendingNote(
  note: {
    created_at: number;
    pubkey?: string;
    tags?: string[][];
    content?: string;
  },
  engagement: NoteEngagement | undefined,
  nowSec?: number,
  options?: TrendingScoreOptions
): number;

export declare function rankTrendingNotes<
  T extends {
    id: string;
    pubkey?: string;
    tags?: string[][];
    content?: string;
  },
>(
  notes: T[],
  engagementById: Record<string, NoteEngagement>,
  options?: RankTrendingNotesOptions
): T[];

export declare function limitTrendingFeed<T extends { id: string }>(
  notes: T[],
  engagementById: Record<string, NoteEngagement>,
  limit?: number
): { notes: T[]; engagementById: Record<string, NoteEngagement> };
