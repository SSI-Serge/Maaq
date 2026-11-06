import type { DishLight, ListItem, ListModel } from "../engine";

/**
 * La liste de courses voyage en JSON entre le serveur et l'écran : le moteur est pur et tourne aussi dans le navigateur, ce qui recalcule les trois scénarios à chaque
 * case cochée sans aller-retour. Les seules valeurs que JSON ne porte pas sont les tables de prix par enseigne (Map), mises sous forme de listes ici.
 */
export interface ItemDto extends Omit<ListItem, "storePrices"> {
  storePrices: [string, { ref: string; price: number | null }][];
}

export interface ListModelDto {
  items: ItemDto[];
  dishes: DishLight[];
}

export const toDto = (model: ListModel): ListModelDto => ({
  items: model.items.map((i) => ({ ...i, storePrices: [...i.storePrices] })),
  dishes: model.dishes,
});

export const fromDto = (dto: ListModelDto): ListModel => ({
  items: dto.items.map((i) => ({ ...i, storePrices: new Map(i.storePrices) })),
  dishes: dto.dishes,
});
