import { SOURCE_LABEL, type DirectorySource, type ExternalPlace, type PlacesDirectory } from "@/server/adapters/places/types";
import type { ServiceRequest } from "./match-store";
import { MAX_EXTERNAL, MAX_SHOWN } from "./rules";

/**
 * Annuaire externe (phase 2c) : complète les vitrines de membres quand elles sont moins de MAX_SHOWN, dans un bloc
 * à part. L'annuaire ne reçoit que la catégorie et le code postal de la demande : jamais son texte. Les résultats
 * ne sont pas conservés (conditions Google) et ne donnent jamais lieu à une carte de mise en relation.
 */

export interface ExternalBlock {
  source: DirectorySource;
  places: ExternalPlace[];
}

/** Faut-il compléter ? Seulement avec une catégorie et un code postal, et quand il manque des vitrines. */
export function shouldComplement(request: Pick<ServiceRequest, "categoryCode" | "postcode">, memberCount: number): boolean {
  return memberCount < MAX_SHOWN && request.categoryCode !== null && request.postcode !== null;
}

export async function searchExternal(directory: PlacesDirectory, request: Pick<ServiceRequest, "categoryCode" | "postcode">, categoryLabel: (code: string) => string, memberCount: number): Promise<ExternalBlock | null> {
  if (directory.source === "none" || !shouldComplement(request, memberCount)) return null;
  const limit = Math.min(MAX_EXTERNAL, MAX_SHOWN - memberCount);
  const places = await directory.search({ categoryCode: request.categoryCode!, categoryLabel: categoryLabel(request.categoryCode!), postcode: request.postcode!, limit });
  if (places.length === 0) return null;
  return { source: places[0].source, places: places.slice(0, limit) };
}

function fr(n: number): string {
  return String(Math.round(n * 10) / 10).replace(".", ",");
}

export function renderPlace(place: ExternalPlace): string {
  const parts = [place.name];
  if (place.rating !== null) parts.push(`${fr(place.rating)}/5${place.reviewCount !== null ? ` (${place.reviewCount} avis)` : ""}`);
  else parts.push("sans avis");
  if (place.locality) parts.push(place.locality);
  if (place.url) parts.push(place.url);
  return `— ${parts.join(" · ")}`;
}

/** Bloc affiché à l'acheteur, nettement séparé des vitrines de membres. */
export function renderExternal(block: ExternalBlock): string {
  return [`Hors MAAQ, ${SOURCE_LABEL[block.source]} :`, ...block.places.map(renderPlace), "Ces établissements ne sont pas membres de MAAQ : contactez-les directement, MAAQ ne peut pas faire de mise en relation."].join("\n");
}
