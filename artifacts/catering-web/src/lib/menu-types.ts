import type { MenuItem } from "@workspace/api-client-react";

export interface PanSizeMenuItem extends MenuItem {
  pricingTemplate: "pan_sizes";
  size1Label?: string | null;
  size1Price?: number | null;
  size1Servings?: number | null;
  size2Label?: string | null;
  size2Price?: number | null;
  size2Servings?: number | null;
  size3Label?: string | null;
  size3Price?: number | null;
  size3Servings?: number | null;
  size4Label?: string | null;
  size4Price?: number | null;
  size4Servings?: number | null;
  size5Label?: string | null;
  size5Price?: number | null;
  size5Servings?: number | null;
}

export function isPanSizesItem(item: MenuItem): item is PanSizeMenuItem {
  return (item as { pricingTemplate?: string }).pricingTemplate === "pan_sizes";
}
