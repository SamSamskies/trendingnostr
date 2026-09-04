export declare const TRENDING_RELAY: string;
export declare const WINE_TRENDING_API: string;
export declare const WINE_TRENDING_LIMIT: number;
export declare const RELAY_ALIGNED_TRENDING_HOURS: 48;
export declare const WINE_MIN_REQUEST_INTERVAL_MS: number;

export declare const EVENT_HYDRATION_RELAYS: readonly string[];
export declare const ENGAGEMENT_RELAYS: readonly string[];
export declare const ENGAGEMENT_BACKFILL_MAX: number;
export declare const ENGAGEMENT_ID_CHUNK_SIZE: number;
export declare const ENGAGEMENT_QUERY_LIMIT: number;

export declare const RELAY_MAX_WAIT_MS: number;
export declare const TRENDING_FETCH_ATTEMPTS: number;

export declare const RANK_WEIGHT_REACTIONS: number;
export declare const RANK_WEIGHT_REPLIES: number;
export declare const RANK_WEIGHT_REPOSTS: number;
export declare const RANK_ZAP_LOG_SCALE: number;
export declare const RANK_AGE_OFFSET_HOURS: number;
export declare const RANK_GRAVITY: number;

export declare function chunkArray<T>(array: T[], chunkSize: number): T[][];

export type NoteEngagement = {
  reactions: number;
  replies: number;
  reposts: number;
  zapAmount: number;
};

export declare function scoreTrendingNote(
  note: { created_at: number },
  engagement: NoteEngagement | undefined,
  nowSec?: number
): number;

export declare function rankTrendingNotes<T extends { id: string }>(
  notes: T[],
  engagementById: Record<string, NoteEngagement>,
  nowSec?: number
): T[];
