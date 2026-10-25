"""Pseudonymisation des échanges avec le modèle (décisions D31 et D37 du PO).

Ce module est la RÉFÉRENCE de comportement pour le backend (à porter dans son langage) :
- les prénoms des membres sont remplacés par « Parent N » / « Enfant N » avant l'envoi au modèle ;
- les adresses email et les numéros de téléphone sont masqués ;
- les alias reçus du modèle (réponse affichée ET paramètres des outils) sont retraduits en prénoms.

Les messages restent en clair chez MAAQ : l'alias n'est appliqué qu'au moment de l'envoi. Dans le backend, le numéro d'alias est
attribué à la création du membre et jamais réutilisé ; ici il suit l'ordre de la famille dans le fichier de test.
"""

import re
import unicodedata

ROLE_LIBELLE = {"parent": "Parent", "enfant": "Enfant"}
RE_EMAIL = re.compile(r"[\w.%+\-]+@[\w.\-]+\.[^\W\d_]{2,}")
# Numéros français (06 12 34 56 78, 0612345678, +33 6 12 34 56 78, 06.12.34.56.78) et internationaux ; pas les dates ni les heures.
RE_TEL_FR = re.compile(r"(?<!\d)(?:(?:\+|00)33[\s.\-]?\(?0?\)?|0)[1-9](?:[\s.\-]?\d{2}){4}(?!\d)")
RE_TEL_INTL = re.compile(r"(?<![\d+])\+\d{1,3}[\s.\-]?\d(?:[\s.\-]?\d{2,4}){2,4}(?!\d)")
RE_ALIAS = re.compile(r"(?<!\w)(Parent|Enfant) (\d+)(?!\d)")


def _plier_car(c: str) -> str:
    """Minuscule sans accent ; garde la longueur d'origine pour que les positions se recopient."""
    sans = "".join(x for x in unicodedata.normalize("NFD", c) if unicodedata.category(x) != "Mn").lower()
    return sans if len(sans) == 1 else c


def plier(texte: str) -> str:
    return "".join(_plier_car(c) for c in unicodedata.normalize("NFC", texte))


def tranche_age(age) -> str:
    if age is None:
        return "inconnu"
    if age < 3:
        return "0-2"
    if age < 6:
        return "3-5"
    if age < 11:
        return "6-10"
    if age < 15:
        return "11-14"
    if age < 18:
        return "15-17"
    return "18+"


class Pseudonymiseur:
    def __init__(self, famille: list, actif: bool = True):
        self.actif = actif
        self.membres = []
        compteurs = {}
        for m in famille:
            role = "enfant" if m.get("role") == "enfant" else "parent"
            compteurs[role] = compteurs.get(role, 0) + 1
            self.membres.append({
                "prenom": m["prenom"], "role": role, "age": m.get("age"),
                "alias": f"{ROLE_LIBELLE[role]} {compteurs[role]}",
            })
        self.par_alias = {m["alias"]: m for m in self.membres}
        self.par_cle = {}
        self.avertissements = []
        for m in self.membres:
            cle = plier(m["prenom"]).strip()
            if cle in self.par_cle:
                self.avertissements.append(f"prénom ambigu : « {m['prenom']} »")
            else:
                self.par_cle[cle] = m
        cles = sorted(self.par_cle, key=len, reverse=True)  # le plus long d'abord
        # Le trait d'union compte comme une lettre : « Jean-Pierre » ne se coupe pas, « Marie-Claire » n'est pas « Marie ».
        self._re_noms = re.compile(r"(?<![\w-])(?:" + "|".join(re.escape(c) for c in cles) + r")(?![\w-])") if cles else None

    # -- vers le modèle ---------------------------------------------------------------------------------------------
    def vers_modele(self, texte: str) -> str:
        t = unicodedata.normalize("NFC", texte or "")
        if not self.actif:
            return t
        t = RE_EMAIL.sub("[email]", t)
        t = RE_TEL_FR.sub("[téléphone]", t)
        t = RE_TEL_INTL.sub("[téléphone]", t)
        if not self._re_noms:
            return t
        pliee, sortie, dernier = plier(t), [], 0
        for m in self._re_noms.finditer(pliee):
            sortie.append(t[dernier:m.start()])
            sortie.append(self.par_cle[m.group(0)]["alias"])
            dernier = m.end()
        sortie.append(t[dernier:])
        return "".join(sortie)

    def ref_de(self, prenom: str) -> str:
        """Référence donnée au modèle pour un membre (son prénom si la pseudonymisation est désactivée)."""
        if not self.actif:
            return prenom
        m = self.par_cle.get(plier(prenom).strip())
        return m["alias"] if m else prenom

    def tranche_ou_age(self, membre: dict):
        return tranche_age(membre.get("age"))

    # -- depuis le modèle -------------------------------------------------------------------------------------------
    def vers_utilisateur(self, texte):
        """Alias retraduits en prénoms ; un alias inconnu est laissé tel quel."""
        if not self.actif or not isinstance(texte, str):
            return texte
        return RE_ALIAS.sub(lambda m: self.par_alias.get(f"{m.group(1)} {m.group(2)}", {"prenom": m.group(0)})["prenom"], texte)

    def retraduire_arbre(self, valeur):
        if isinstance(valeur, str):
            return self.vers_utilisateur(valeur)
        if isinstance(valeur, list):
            return [self.retraduire_arbre(v) for v in valeur]
        if isinstance(valeur, dict):
            return {k: self.retraduire_arbre(v) for k, v in valeur.items()}
        return valeur

    def prenom_de(self, ref):
        """Résout une référence de membre reçue d'un outil. Avec la pseudonymisation, seul un alias est accepté."""
        ref = str(ref).strip()
        if self.actif:
            m = self.par_alias.get(ref)
        else:
            m = self.par_cle.get(plier(ref).strip())
        return m["prenom"] if m else None

    def alias_inconnus(self, texte: str) -> list:
        return [m.group(0) for m in RE_ALIAS.finditer(texte or "") if f"{m.group(1)} {m.group(2)}" not in self.par_alias]

    # -- contrôle ---------------------------------------------------------------------------------------------------
    def fuites(self, texte: str) -> list:
        """Ce qui reste d'identifiant dans un texte déjà destiné au modèle."""
        trouve = []
        if RE_EMAIL.search(texte):
            trouve.append("email")
        if RE_TEL_FR.search(texte) or RE_TEL_INTL.search(texte):
            trouve.append("téléphone")
        if self._re_noms and self._re_noms.search(plier(texte)):
            trouve.append("prénom")
        return trouve
