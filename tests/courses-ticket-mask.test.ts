import { describe, expect, it } from "vitest";
import { MASK, maskTicketText } from "@/server/courses/tickets/mask";

/** Tickets entièrement fictifs (CR-31 : aucun vrai ticket dans le dépôt ni dans les tests). */
const FICTIVE = [
  "SUPERMARCHE EXEMPLE - 12 rue des Tests",
  "Bonjour Camille",
  "Caissière : Sophie M.",
  "Lait demi-écrémé 1 L      2 x 0,95   1,90",
  "Poulet fermier 1,2 kg                 6,49",
  "Carte de fidélité n° 2500123456789",
  "Cagnotte fidélité : 3,40 EUR",
  "Client : DUPONT Jean",
  "Code-barres 3017620422003",
  "TOTAL 8,39 EUR",
  "Carte bancaire **** **** **** 4821 8,39",
  "Contact : service@exemple-magasin.fr / 01 02 03 04 05",
  "Merci de votre visite",
  "Merci Camille et à bientôt",
  "05/11/2026 18:42",
].join("\n");

describe("Masquage du texte d'un ticket (US-161 RF2, CR-05)", () => {
  const { text, masked } = maskTicketText(FICTIVE);

  it("masque la carte de fidélité, la cagnotte, le nom du client et les suites de 9 chiffres ou plus", () => {
    expect(text).not.toMatch(/2500123456789/);
    expect(text).not.toMatch(/3017620422003/);
    expect(text).not.toMatch(/DUPONT/);
    expect(text).not.toMatch(/cagnotte/i);
    expect(text).not.toMatch(/fidélité n°/i);
  });

  it("masque le prénom du caissier, le prénom d'un message d'accueil, l'adresse email et le téléphone", () => {
    expect(text).toMatch(new RegExp(`Caissière : ${MASK.replace(/[[\]]/g, "\\$&")}`));
    expect(text).not.toMatch(/Sophie/);
    expect(text).not.toMatch(/Camille/);
    expect(text).not.toMatch(/service@exemple/);
    expect(text).not.toMatch(/01 02 03 04 05/);
  });

  it("garde ce qui sert à lire le ticket : produits, quantités, prix, total, date, ligne de paiement sans numéro", () => {
    expect(text).toContain("Lait demi-écrémé 1 L      2 x 0,95   1,90");
    expect(text).toContain("Poulet fermier 1,2 kg                 6,49");
    expect(text).toContain("TOTAL 8,39 EUR");
    expect(text).toContain("05/11/2026 18:42");
    expect(text).toContain("Merci de votre visite");
    const payment = text.split("\n").find((l) => /bancaire/i.test(l))!;
    expect(payment).toContain("8,39");
    expect(payment).not.toMatch(/4821/);
    expect(masked).toBeGreaterThanOrEqual(8);
  });

  it("un texte sans donnée personnelle reste identique", () => {
    const plain = "Pommes 1,5 kg   2,99\nRiz 1 kg   2,55\nTOTAL 5,54";
    expect(maskTicketText(plain)).toEqual({ text: plain, masked: 0 });
  });
});
