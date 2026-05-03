import {
  getAdminListRecommendationsQueryKey,
  useAdminListRecommendations,
  useAdminAddRecommendation,
  useAdminRemoveRecommendation,
  useAdminReorderRecommendations,
  useAdminListTopSellers,
  useAdminSyncRecommendations,
  type RecommendedItem,
  type TopSeller,
  type SyncRecommendationsResponse,
  type SyncRecommendationsBodyMode,
} from "@workspace/api-client-react";

export const RECOMMENDATIONS_QUERY_KEY = getAdminListRecommendationsQueryKey();

export {
  useAdminListRecommendations,
  useAdminAddRecommendation,
  useAdminRemoveRecommendation,
  useAdminReorderRecommendations,
  useAdminListTopSellers,
  useAdminSyncRecommendations,
};

export type { RecommendedItem, TopSeller, SyncRecommendationsResponse, SyncRecommendationsBodyMode };
