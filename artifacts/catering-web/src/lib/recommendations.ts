// Thin re-exports of generated hooks/types so the admin page consumes
// the OpenAPI-generated TanStack Query hooks (per the contract-first
// convention in the pnpm-workspace skill). The query key helper from the
// generated client is re-exported as RECOMMENDATIONS_QUERY_KEY for
// invalidation in the page.
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
