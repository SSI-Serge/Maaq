"""Banc d'essai de l'agent « Assistant Famille » (version alignée sur les décisions du PO).

Envoie chaque cas de tests/cas_de_test.json à Claude avec les instructions et les outils de l'agent. Les outils sont simulés sur un
calendrier fictif (aucune donnée réelle). Chaque réponse est comparée au résultat attendu, puis un rapport est écrit dans resultats/.

Par rapport à la version précédente, le banc applique les règles du PO (D31, D35, D37) comme le fera le backend :
- les prénoms sont remplacés par « Parent N » / « Enfant N » avant l'envoi au modèle, les adresses email et téléphones masqués,
  et les alias reçus sont retraduits (réponse et paramètres des outils) : voir pseudonymisation.py ;
- les événements existants sont décrits au modèle sans titre, lieu ni note ;
- un rendez-vous médical reçoit un titre générique « RDV médical — [prénom] », sans lieu ni note ;
- six types de rendez-vous ; doublon = même jour, membre commun, heure à 30 minutes près, objet équivalent.

Usage :
    python banc_essai/lancer_tests.py                 # tous les cas, règles du PO appliquées
    python banc_essai/lancer_tests.py --sans-pseudo   # même agent sans alias ni minimisation (mesure de l'écart de qualité)
    python banc_essai/lancer_tests.py --cas 04 12     # seulement les cas dont l'id commence par 04 ou 12
    python banc_essai/lancer_tests.py --verifier      # contrôle hors ligne, sans appel à Claude
"""

import argparse
import copy
import json
import os
import re
import sys
import time
import unicodedata
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pseudonymisation import Pseudonymiseur, tranche_age  # noqa: E402

RACINE = Path(__file__).resolve().parent.parent
FORMAT_DATE_HEURE = "%Y-%m-%dT%H:%M"
FORMAT_DATE = "%Y-%m-%d"
MAX_TOURS = 12
MAX_PHRASES = 3
SEUIL_DUREE_S = 10  # critère du brief : rendez-vous provisoire en moins de 10 secondes
TYPES = ["ecole", "medical", "pro", "familial", "perso", "admin"]
TUTOIEMENT = re.compile(r"\b(tu|toi|ton|ta|tes|te|tien|tienne)\b|\bt'")
REF_EVENEMENT = re.compile(r"\[\[(evt-\d+)\]\]")
MOTS_VIDES = {"rendez", "vous", "avec", "pour", "dans", "chez", "votre", "notre", "cabinet"}


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

def charger_env(chemin: Path) -> None:
    """Charge un fichier .env simple (CLE=valeur) sans écraser l'environnement."""
    if not chemin.exists():
        return
    for ligne in chemin.read_text(encoding="utf-8").splitlines():
        ligne = ligne.strip()
        if not ligne or ligne.startswith("#") or "=" not in ligne:
            continue
        cle, valeur = ligne.split("=", 1)
        os.environ.setdefault(cle.strip(), valeur.strip().strip('"').strip("'"))


def normaliser(texte: str) -> str:
    """Minuscules sans accents, pour comparer prénoms et textes."""
    sans_accents = unicodedata.normalize("NFD", texte or "")
    return "".join(c for c in sans_accents if unicodedata.category(c) != "Mn").lower().strip()


def jetons(texte: str) -> set:
    """Mots significatifs d'un objet de rendez-vous (4 lettres ou plus, sans mots vides)."""
    return {m for m in re.split(r"[^a-z0-9]+", normaliser(texte)) if len(m) >= 4 and m not in MOTS_VIDES}


def lire_date(valeur: str) -> datetime:
    """Accepte AAAA-MM-JJTHH:MM (avec ou sans secondes) ou AAAA-MM-JJ."""
    valeur = (valeur or "").strip()
    for fmt in (FORMAT_DATE_HEURE, "%Y-%m-%dT%H:%M:%S", FORMAT_DATE):
        try:
            return datetime.strptime(valeur, fmt)
        except ValueError:
            continue
    raise ValueError(f"date illisible : « {valeur} » (attendu AAAA-MM-JJTHH:MM ou AAAA-MM-JJ)")


# ---------------------------------------------------------------------------
# Outils simulés sur un calendrier fictif
# ---------------------------------------------------------------------------

class CalendrierSimule:
    """Référence de comportement des outils côté backend.

    Les événements sont rangés avec les vrais prénoms ; ce que le modèle voit et envoie passe par le pseudonymiseur.
    `minimiser` : événements existants décrits sans titre ni lieu ni note, titre générique des rendez-vous médicaux (D31).
    """

    def __init__(self, famille: list, evenements: list, pseudo: Pseudonymiseur, minimiser: bool = True, auteur: str = None):
        self.famille = famille
        self.auteur = auteur  # parent qui écrit (D39) : ajouté d'office aux membres de la recherche de doublon
        self.evenements = copy.deepcopy(evenements)
        self.pseudo = pseudo
        self.minimiser = minimiser
        self.compteur = 100

    # -- outils internes ----------------------------------------------------------------------------------------------
    def _bornes(self, evt: dict) -> tuple:
        debut = lire_date(evt["debut"])
        fin = lire_date(evt["fin"])
        if evt.get("journee_entiere") or len(evt["fin"]) == 10:
            fin = fin.replace(hour=23, minute=59)
        return debut, fin

    def _prenom(self, ref: str) -> str:
        prenom = self.pseudo.prenom_de(ref)
        if prenom is None:
            raise ValueError(f"membre inconnu : « {ref} ». Utilisez une référence renvoyée par lister_membres.")
        return prenom

    def _prenoms(self, refs: list) -> list:
        if not refs:
            raise ValueError("au moins un membre est attendu")
        return [self._prenom(r) for r in refs]

    def _actifs(self) -> list:
        return [e for e in self.evenements if e.get("statut") not in ("annulation_proposee",)]

    def _public(self, evt: dict) -> dict:
        """Événement tel que le modèle le voit."""
        vu = {"id": evt["id"], "debut": evt["debut"], "fin": evt["fin"], "type": evt["type"], "statut": evt.get("statut"),
              "membres": [self.pseudo.ref_de(m) for m in evt["membres"]]}
        if evt.get("journee_entiere"):
            vu["journee_entiere"] = True
        if not self.minimiser:
            vu.update({"titre": evt["titre"], "lieu": evt.get("lieu"), "notes": evt.get("notes")})
        return vu

    def _conflits(self, debut: datetime, fin: datetime, prenoms: list) -> list:
        cibles = {normaliser(m) for m in prenoms}
        resultat = []
        for evt in self._actifs():
            ed, ef = self._bornes(evt)
            if ed < fin and ef > debut and cibles & {normaliser(m) for m in evt["membres"]}:
                resultat.append(evt)
        return resultat

    def executer(self, nom: str, entree: dict) -> dict:
        methode = getattr(self, f"outil_{nom}", None)
        if methode is None:
            raise ValueError(f"outil inconnu : {nom}")
        return methode(**entree)

    # -- outils exposés au modèle ---------------------------------------------------------------------------------------
    def outil_lister_membres(self) -> dict:
        membres = []
        for m in self.pseudo.membres:
            if self.pseudo.actif:
                membres.append({"ref": m["alias"], "role": m["role"], "tranche_age": tranche_age(m["age"])})
            else:
                membres.append({"ref": m["prenom"], "role": m["role"], "age": m["age"]})
        return {"membres": membres}

    def outil_lister_evenements(self, date_debut: str, date_fin: str, membre: str = None) -> dict:
        debut = lire_date(date_debut)
        fin = lire_date(date_fin).replace(hour=23, minute=59)
        filtre = normaliser(self._prenom(membre)) if membre else None
        resultats = []
        for evt in self._actifs():
            d, f = self._bornes(evt)
            if d <= fin and f >= debut:
                if filtre and filtre not in [normaliser(m) for m in evt["membres"]]:
                    continue
                resultats.append(evt)
        resultats.sort(key=lambda e: e["debut"])
        return {"evenements": [self._public(e) for e in resultats]}

    def outil_verifier_conflits(self, debut: str, fin: str, membres: list) -> dict:
        d, f = lire_date(debut), lire_date(fin)
        if f <= d:
            raise ValueError("la fin doit être après le début")
        conflits = self._conflits(d, f, self._prenoms(membres))
        return {"conflits": [self._public(e) for e in conflits], "libre": not conflits}

    def outil_proposer_creneaux(self, date_souhaitee: str, duree_minutes: int, membres: list, nombre: int = 3) -> dict:
        prenoms = self._prenoms(membres)
        jour = lire_date(date_souhaitee).replace(hour=0, minute=0)
        duree = timedelta(minutes=int(duree_minutes))
        creneaux = []
        for decalage in range(0, 14):
            base = jour + timedelta(days=decalage)
            debut = base.replace(hour=8)
            while debut + duree <= base.replace(hour=20) and len(creneaux) < nombre:
                fin = debut + duree
                if not self._conflits(debut, fin, prenoms) and debut.hour in (9, 10, 14, 17, 18):
                    creneaux.append({"debut": debut.strftime(FORMAT_DATE_HEURE), "fin": fin.strftime(FORMAT_DATE_HEURE)})
                    debut = base.replace(hour=23)  # au plus un créneau par jour
                else:
                    debut += timedelta(minutes=30)
            if len(creneaux) >= nombre:
                break
        return {"creneaux": creneaux}

    def outil_rechercher_doublon(self, date: str, objet: str, heure: str = None, type: str = None, membres: list = None) -> dict:
        """Même jour ; heure à 30 minutes près si donnée ; membre commun si des membres sont donnés ; objet équivalent
        (un mot significatif en commun avec le titre ou le lieu) ou, pour un rendez-vous médical, même type (D35)."""
        jour = lire_date(date).date()
        cibles = {normaliser(p) for p in self._prenoms(membres)} if membres else set()
        if cibles and self.auteur:
            cibles.add(normaliser(self.auteur))  # D39 : règle du serveur, indépendante du modèle
        cles = jetons(self.pseudo.vers_utilisateur(objet or ""))
        trouves = []
        for evt in self._actifs():
            d, _ = self._bornes(evt)
            if d.date() != jour:
                continue
            if heure:
                h = datetime.strptime(f"{jour} {heure}", "%Y-%m-%d %H:%M")
                if abs((d - h).total_seconds()) > 1800:
                    continue
            if cibles and not cibles & {normaliser(m) for m in evt["membres"]}:
                continue
            meme_type_medical = type == "medical" and evt["type"] == "medical"
            equivalent = bool(cles & jetons(evt["titre"] + " " + (evt.get("lieu") or "")))
            if meme_type_medical or equivalent:
                trouves.append(evt)
        return {"correspondances": [self._public(e) for e in trouves]}

    def outil_creer_evenement_provisoire(self, titre, type, debut, fin, journee_entiere, membres, source,
                                         lieu=None, notes=None, recurrence=None) -> dict:
        if type not in TYPES:
            raise ValueError(f"type inconnu : « {type} » (attendu : {', '.join(TYPES)})")
        d, f = lire_date(debut), lire_date(fin)
        if f < d:
            raise ValueError("la fin doit être après le début")
        prenoms = self._prenoms(membres)
        titre_reel = self.pseudo.vers_utilisateur(titre)
        lieu_reel = self.pseudo.vers_utilisateur(lieu) if lieu else lieu
        notes_reelles = self.pseudo.vers_utilisateur(notes) if notes else notes
        avis = None
        if type == "medical" and self.minimiser:
            # D31 : titre générique, ni lieu ni note renseignés par l'agent. Règle appliquée par le backend, pas par le modèle.
            titre_reel = f"RDV médical — {prenoms[0]}"
            if lieu or notes:
                avis = "Pour un rendez-vous médical, le lieu et les notes ne sont pas enregistrés par l'assistant."
            lieu_reel = notes_reelles = None
        self.compteur += 1
        evt = {
            "id": f"evt-{self.compteur}", "titre": titre_reel, "type": type, "debut": debut, "fin": fin,
            "journee_entiere": journee_entiere, "membres": prenoms, "lieu": lieu_reel, "notes": notes_reelles,
            "recurrence": recurrence, "source": source, "statut": "provisoire",
        }
        self.evenements.append(evt)
        reponse = {"id": evt["id"], "statut": "provisoire", "message": "Créé en provisoire, en attente de confirmation par la famille."}
        if avis:
            reponse["avis"] = avis
        return reponse

    def _trouver(self, id: str) -> dict:
        for evt in self.evenements:
            if evt["id"] == id:
                return evt
        raise ValueError(f"aucun événement avec l'identifiant {id}")

    def outil_modifier_evenement(self, id, motif, debut=None, fin=None, lieu=None, notes=None) -> dict:
        evt = self._trouver(id)
        changements = {k: v for k, v in {"debut": debut, "fin": fin, "lieu": lieu, "notes": notes}.items() if v}
        for valeur in (debut, fin):
            if valeur:
                lire_date(valeur)
        evt["modification_proposee"] = {**changements, "motif": motif}
        return {"id": id, "statut": "modification_proposee", "changements": changements}

    def outil_annuler_evenement(self, id, motif) -> dict:
        evt = self._trouver(id)
        evt["statut"] = "annulation_proposee"
        evt["motif_annulation"] = motif
        return {"id": id, "statut": "annulation_proposee"}

    # -- affichage -------------------------------------------------------------------------------------------------------
    def developper_references(self, texte: str) -> str:
        """Remplace [[evt-003]] par le titre de l'événement, comme le fera l'application à l'affichage (D39) :
        un identifiant inconnu (ou qu'un profil n'a pas le droit de voir, D26) devient « un rendez-vous » ; un rendez-vous médical
        garde son titre générique."""
        def remplacer(m):
            for evt in self.evenements:
                if evt["id"] == m.group(1):
                    if evt["type"] == "medical" and self.minimiser:
                        return f"RDV médical — {evt['membres'][0]}"
                    return evt["titre"]
            return "un rendez-vous"
        return REF_EVENEMENT.sub(remplacer, texte)


# ---------------------------------------------------------------------------
# Conversation avec Claude
# ---------------------------------------------------------------------------

def creer_client():
    import anthropic

    fournisseur = os.environ.get("FOURNISSEUR", "anthropic").lower()
    if fournisseur == "foundry":
        return anthropic.AnthropicFoundry(
            api_key=os.environ["FOUNDRY_API_KEY"],
            resource=os.environ["FOUNDRY_RESOURCE"],
        ), fournisseur
    if fournisseur == "anthropic":
        if not os.environ.get("ANTHROPIC_API_KEY"):
            sys.exit("ANTHROPIC_API_KEY est vide : renseignez-la dans le fichier agent/.env")
        return anthropic.Anthropic(), fournisseur
    sys.exit(f"FOURNISSEUR inconnu : {fournisseur} (attendu : anthropic ou foundry)")


class Appelant:
    """Envoie les requêtes à Claude, avec repli automatique en cas de refus sur l'API Anthropic."""

    def __init__(self, client, fournisseur: str, modele: str, effort: str, instructions: str, outils: list):
        self.client = client
        self.fournisseur = fournisseur
        self.modele = modele
        self.effort = effort
        self.instructions = instructions
        self.outils = outils
        # Le paramètre « fallbacks » n'existe que sur l'API Anthropic directe.
        self.avec_repli = fournisseur == "anthropic"

    def envoyer(self, messages: list):
        import anthropic

        parametres = dict(
            model=self.modele,
            max_tokens=16000,
            system=self.instructions,
            tools=self.outils,
            messages=messages,
        )
        if self.effort:
            parametres["output_config"] = {"effort": self.effort}
        if self.fournisseur == "anthropic":
            parametres["cache_control"] = {"type": "ephemeral"}

        if self.avec_repli:
            try:
                return self.client.beta.messages.create(
                    betas=["server-side-fallback-2026-07-01"], fallbacks="default", **parametres
                )
            except (TypeError, anthropic.BadRequestError) as erreur:
                if "fallback" not in str(erreur).lower():
                    raise
                print("  (repli automatique indisponible avec cette version du SDK : désactivé)")
                self.avec_repli = False
        return self.client.messages.create(**parametres)


def construire_message(contexte: dict, cas: dict, pseudo: Pseudonymiseur) -> str:
    """Message envoyé au modèle : la personne qui écrit et le contenu passent par le pseudonymiseur."""
    return (
        "<contexte>\n"
        f"Date et heure actuelles : {contexte['jour']}, {contexte['maintenant'][11:]} ({contexte['fuseau']})\n"
        f"Personne qui écrit : {pseudo.ref_de(contexte['utilisateur'])}\n"
        "</contexte>\n"
        f"<message source=\"{cas['source']}\">\n{pseudo.vers_modele(cas['message'])}\n</message>"
    )


def executer_cas(appelant, donnees: dict, cas: dict, pseudo_actif: bool = True) -> dict:
    pseudo = Pseudonymiseur(donnees["famille"], actif=pseudo_actif)
    calendrier = CalendrierSimule(donnees["famille"], donnees["calendrier_initial"], pseudo, minimiser=pseudo_actif, auteur=donnees["contexte"]["utilisateur"])
    message = construire_message(donnees["contexte"], cas, pseudo)
    messages = [{"role": "user", "content": message}]
    envoyes = [appelant.instructions, message]  # tout ce qui part chez le modèle, pour contrôler les fuites
    appels, jetons_entree, jetons_sortie = [], 0, 0
    texte_final, arret, erreur = "", None, None
    debut_chrono = time.perf_counter()
    tours = 0

    for _ in range(MAX_TOURS):
        tours += 1
        reponse = appelant.envoyer(messages)
        jetons_entree += (reponse.usage.input_tokens + (getattr(reponse.usage, "cache_read_input_tokens", 0) or 0)
                          + (getattr(reponse.usage, "cache_creation_input_tokens", 0) or 0))
        jetons_sortie += reponse.usage.output_tokens
        arret = reponse.stop_reason
        messages.append({"role": "assistant", "content": reponse.content})

        if arret == "tool_use":
            resultats = []
            for bloc in reponse.content:
                if bloc.type != "tool_use":
                    continue
                entree = bloc.input if isinstance(bloc.input, dict) else json.loads(bloc.input)
                reelle = pseudo.retraduire_arbre(entree)  # ce que le backend range : les vrais prénoms
                try:
                    sortie = calendrier.executer(bloc.name, entree)
                    appels.append({"outil": bloc.name, "entree": entree, "entree_reelle": reelle, "sortie": sortie})
                    contenu = json.dumps(sortie, ensure_ascii=False)
                    resultats.append({"type": "tool_result", "tool_use_id": bloc.id, "content": contenu})
                except (TypeError, ValueError, KeyError) as exc:
                    appels.append({"outil": bloc.name, "entree": entree, "entree_reelle": reelle, "erreur": str(exc)})
                    contenu = f"Erreur : {exc}"
                    resultats.append({"type": "tool_result", "tool_use_id": bloc.id, "content": contenu, "is_error": True})
                envoyes.append(contenu)
            messages.append({"role": "user", "content": resultats})
            continue

        brut = "\n".join(b.text for b in reponse.content if b.type == "text").strip()
        # Ce que lira le parent : alias retraduits, identifiants d'événements remplacés par leur titre.
        texte_final = calendrier.developper_references(pseudo.vers_utilisateur(brut))
        if arret == "refusal":
            details = getattr(reponse, "stop_details", None)
            erreur = f"refus du modèle ({getattr(details, 'category', None)})"
        elif arret == "max_tokens":
            erreur = "réponse coupée (max_tokens atteint)"
        break
    else:
        erreur = f"plus de {MAX_TOURS} tours sans réponse finale"

    return {"appels": appels, "texte": texte_final, "arret": arret, "erreur": erreur,
            "jetons_entree": jetons_entree, "jetons_sortie": jetons_sortie,
            "duree": time.perf_counter() - debut_chrono, "tours": tours,
            "fuites": pseudo.fuites("\n".join(envoyes)) if pseudo_actif else [],
            "evenements_finaux": calendrier.evenements}


# ---------------------------------------------------------------------------
# Évaluation
# ---------------------------------------------------------------------------

def _correspond(attendu: dict, evt: dict) -> bool:
    try:
        debut = lire_date(evt["debut"])
    except (KeyError, ValueError):
        return False
    if debut.strftime(FORMAT_DATE) != attendu["date"]:
        return False
    if "heure" in attendu and (len(evt["debut"]) < 16 or debut.strftime("%H:%M") != attendu["heure"]):
        return False
    if "fin" in attendu:
        try:
            if lire_date(evt["fin"]).strftime("%H:%M") != attendu["fin"]:
                return False
        except (KeyError, ValueError):
            return False
    if "journee_entiere" in attendu and bool(evt.get("journee_entiere")) != attendu["journee_entiere"]:
        return False
    if "type" in attendu and evt.get("type") != attendu["type"]:
        return False
    membres = {normaliser(m) for m in evt.get("membres", [])}
    return all(normaliser(m) in membres for m in attendu.get("membres_inclus", []))


def evaluer(cas: dict, resultat: dict) -> list:
    attendu = cas["attendu"]
    appels = resultat["appels"]
    noms = [a["outil"] for a in appels]
    texte = normaliser(resultat["texte"])
    # Les créations réussies, avec les vrais prénoms (alias retraduits comme le fera le backend).
    creations = [a for a in appels if a["outil"] == "creer_evenement_provisoire" and "erreur" not in a]
    echecs = []

    if resultat["erreur"]:
        echecs.append(resultat["erreur"])
    if "creations" in attendu and len(creations) != attendu["creations"]:
        echecs.append(f"{len(creations)} création(s) au lieu de {attendu['creations']}")
    if "creations_min" in attendu and len(creations) < attendu["creations_min"]:
        echecs.append(f"{len(creations)} création(s), au moins {attendu['creations_min']} attendue(s)")

    restantes = [c["entree_reelle"] for c in creations]
    for evt_attendu in attendu.get("evenements", []):
        trouve = next((c for c in restantes if _correspond(evt_attendu, c)), None)
        if trouve is None:
            echecs.append(f"événement attendu non créé ou incorrect : {json.dumps(evt_attendu, ensure_ascii=False)}")
        else:
            restantes.remove(trouve)

    for nom in attendu.get("outils_requis", []):
        if nom not in noms:
            echecs.append(f"outil non appelé : {nom}")
    for nom in attendu.get("outils_interdits", []):
        if nom in noms:
            echecs.append(f"outil interdit appelé : {nom}")

    if "modification" in attendu:
        m = attendu["modification"]
        ok = any(
            a["outil"] == "modifier_evenement" and a["entree"].get("id") == m["id"]
            and a["entree"].get("debut", "").startswith(f"{m['date']}T{m['heure']}")
            for a in appels
        )
        if not ok:
            echecs.append(f"modification attendue de {m['id']} vers {m['date']} {m['heure']}")

    if "annulation" in attendu:
        if not any(a["outil"] == "annuler_evenement" and a["entree"].get("id") == attendu["annulation"] for a in appels):
            echecs.append(f"annulation attendue de {attendu['annulation']}")

    if attendu.get("question") and "?" not in resultat["texte"]:
        echecs.append("une question était attendue dans la réponse")

    for element in attendu.get("texte_contient", []):
        if not any(normaliser(alt) in texte for alt in element.split("|")):
            echecs.append(f"la réponse devrait mentionner « {element} »")

    # D31 : un rendez-vous médical est créé sans lieu ni notes par l'agent, et le backend range un titre générique.
    if attendu.get("medical_sans_detail"):
        for c in creations:
            if c["entree"].get("type") == "medical" and (c["entree"].get("lieu") or c["entree"].get("notes")):
                echecs.append("lieu ou notes renseignés par l'agent sur un rendez-vous médical")
                break
        for evt in resultat.get("evenements_finaux", []):
            if evt.get("source") and evt.get("type") == "medical" and evt.get("statut") == "provisoire":
                if not evt["titre"].startswith("RDV médical — ") or evt.get("lieu") or evt.get("notes"):
                    echecs.append(f"titre ou détails d'un rendez-vous médical non minimisés : {evt['titre']}")

    # D37 : aucun prénom, email ou téléphone ne part chez le modèle.
    if resultat.get("fuites"):
        echecs.append(f"données personnelles envoyées au modèle : {', '.join(resultat['fuites'])}")

    # Règle générale : les parents sont toujours vouvoyés.
    tutoiement = TUTOIEMENT.search(texte.replace("’", "'"))
    if tutoiement:
        echecs.append(f"tutoiement détecté (« {tutoiement.group(0)} »), le vouvoiement est attendu")

    # Règle générale : doublons et conflits vérifiés avant chaque création.
    for i, appel in enumerate(appels):
        if appel["outil"] == "creer_evenement_provisoire":
            precedents = noms[:i]
            if "rechercher_doublon" not in precedents or "verifier_conflits" not in precedents:
                echecs.append("création sans vérification préalable des doublons et des conflits")
                break

    return echecs


def remarquer(resultat: dict) -> list:
    """Points de style signalés dans le rapport, sans faire échouer le cas."""
    remarques = []
    phrases = [p for p in re.split(r"(?<=[.!?])\s+", resultat["texte"].strip()) if p.strip()]
    if len(phrases) > MAX_PHRASES:
        remarques.append(f"{len(phrases)} phrases (au plus {MAX_PHRASES} attendues)")
    if resultat.get("duree", 0) > SEUIL_DUREE_S:
        remarques.append(f"{resultat['duree']:.1f} s (objectif : moins de {SEUIL_DUREE_S} s)")
    return remarques


# ---------------------------------------------------------------------------
# Rapport
# ---------------------------------------------------------------------------

def percentile(valeurs: list, p: int) -> float:
    if not valeurs:
        return 0.0
    tri = sorted(valeurs)
    return tri[min(len(tri) - 1, max(0, -(-p * len(tri) // 100) - 1))]


def ecrire_rapport(modele: str, fournisseur: str, resultats: list, pseudo_actif: bool) -> Path:
    dossier = RACINE / "resultats"
    dossier.mkdir(exist_ok=True)
    horodatage = datetime.now().strftime("%Y%m%d_%H%M%S")
    chemin = dossier / f"rapport_{horodatage}{'' if pseudo_actif else '_sans_pseudo'}.md"

    reussis = sum(1 for r in resultats if not r["echecs"])
    entree = sum(r["jetons_entree"] for r in resultats)
    sortie = sum(r["jetons_sortie"] for r in resultats)
    durees = [r["duree"] for r in resultats]
    lignes = [
        f"# Rapport du banc d'essai – {datetime.now():%d/%m/%Y %H:%M}",
        "",
        f"- Modèle : `{modele}` via `{fournisseur}`",
        f"- Règles du PO (alias, minimisation, titre médical générique) : **{'appliquées' if pseudo_actif else 'DÉSACTIVÉES (mesure de référence)'}**",
        f"- Résultat : **{reussis} / {len(resultats)} cas réussis**",
        f"- Durée par cas : médiane {percentile(durees, 50):.1f} s, 95e centile {percentile(durees, 95):.1f} s, "
        f"{sum(1 for d in durees if d < SEUIL_DUREE_S)} / {len(durees)} sous {SEUIL_DUREE_S} s",
        f"- Jetons : {entree:,} en entrée, {sortie:,} en sortie".replace(",", " "),
        "",
        "| Cas | Résultat | Durée (s) | Problèmes | Remarques |",
        "|---|---|---|---|---|",
    ]
    for r in resultats:
        statut = "OK" if not r["echecs"] else "ÉCHEC"
        lignes.append(f"| {r['id']} – {r['titre']} | {statut} | {r['duree']:.1f} | {'; '.join(r['echecs']) or '–'} | {'; '.join(r['remarques']) or '–'} |")
    doublons = [r for r in resultats if r["attendu"].get("doublon_attendu")]
    if doublons:
        manques = [r for r in doublons if any(a["outil"] == "creer_evenement_provisoire" and "erreur" not in a for a in r["appels"])]
        lignes += ["", f"**Doublons manqués : {len(manques)} / {len(doublons)}** (cas où un doublon devait être reconnu)", ""]
        lignes += ["| Cas | Doublon reconnu | Membres passés à `rechercher_doublon` | Recherches |", "|---|---|---|---|"]
        for r in doublons:
            recherches = [a for a in r["appels"] if a["outil"] == "rechercher_doublon"]
            membres = "; ".join(", ".join((a["entree_reelle"].get("membres") or ["(aucun)"])) for a in recherches) or "(aucune recherche)"
            trouve = any(a.get("sortie", {}).get("correspondances") for a in recherches)
            reconnu = "oui" if r not in [x for x in manques] else "NON (créé en double)"
            lignes.append(f"| {r['id']} | {reconnu} | {membres} | {'trouvé' if trouve else 'rien trouvé'} |")
    lignes.append("")
    for r in resultats:
        lignes += [f"## {r['id']} – {r['titre']}", "", "**Message :**", "", "```", r["message"], "```", "", "**Appels d'outils :**", ""]
        if not r["appels"]:
            lignes.append("- aucun")
        for a in r["appels"]:
            detail = json.dumps(a["entree"], ensure_ascii=False)
            suite = f" → erreur : {a['erreur']}" if "erreur" in a else ""
            lignes.append(f"- `{a['outil']}` {detail}{suite}")
        lignes += ["", "**Réponse affichée au parent :**", "", f"> {r['texte'] or '(vide)'}".replace("\n", "\n> "), ""]
        if r["echecs"]:
            lignes += ["**Problèmes :**", ""] + [f"- {e}" for e in r["echecs"]] + [""]
    chemin.write_text("\n".join(lignes), encoding="utf-8")
    return chemin


# ---------------------------------------------------------------------------
# Contrôle hors ligne
# ---------------------------------------------------------------------------

class _ClientScenarise:
    """Faux modèle pour le contrôle hors ligne : rejoue une suite d'appels d'outils, sans réseau."""

    def __init__(self, etapes):
        self.etapes = etapes
        self.instructions = "instructions de contrôle"
        self.recu = []

    def envoyer(self, messages):
        self.recu.append(messages)
        etape = self.etapes[len(self.recu) - 1]
        contenu = etape(messages) if callable(etape) else etape
        usage = SimpleNamespace(input_tokens=100, output_tokens=20, cache_read_input_tokens=0, cache_creation_input_tokens=0)
        utilise = [b for b in contenu if b.type == "tool_use"]
        return SimpleNamespace(content=contenu, usage=usage, stop_reason="tool_use" if utilise else "end_turn")


def _outil(id_, nom, **entree):
    return SimpleNamespace(type="tool_use", id=id_, name=nom, input=entree)


def _texte(texte):
    return SimpleNamespace(type="text", text=texte)


def verifier_hors_ligne(donnees: dict, outils: list) -> None:
    """Vérifie fichiers, outils simulés, pseudonymisation, évaluation et un déroulé complet sans appeler Claude."""
    noms_outils = {o["name"] for o in outils}
    methodes = {n[len("outil_"):] for n in dir(CalendrierSimule) if n.startswith("outil_")}
    assert noms_outils == methodes, f"outils déclarés et simulés différents : {noms_outils ^ methodes}"
    for o in outils:
        for propriete in o["input_schema"].get("properties", {}).values():
            if "ecole" in propriete.get("enum", []):
                assert set(propriete["enum"]) == set(TYPES), f"types différents dans {o['name']}"

    cles_connues = {"creations", "creations_min", "evenements", "outils_requis", "outils_interdits",
                    "modification", "annulation", "question", "texte_contient", "medical_sans_detail", "doublon_attendu"}
    ids = [c["id"] for c in donnees["cas"]]
    assert len(ids) == len(set(ids)), "identifiants de cas en double"
    for cas in donnees["cas"]:
        inconnues = set(cas["attendu"]) - cles_connues
        assert not inconnues, f"{cas['id']} : clés inconnues {inconnues}"
        for nom in cas["attendu"].get("outils_requis", []) + cas["attendu"].get("outils_interdits", []):
            assert nom in noms_outils, f"{cas['id']} : outil inconnu {nom}"
    for evt in donnees["calendrier_initial"]:
        assert evt["type"] in TYPES, f"{evt['id']} : type {evt['type']} hors des six types"

    # Pseudonymisation
    p = Pseudonymiseur(donnees["famille"])
    assert p.vers_modele("Dentiste pour LÉO, d'Emma et Marc") == "Dentiste pour Enfant 1, d'Enfant 2 et Parent 2", p.vers_modele("Dentiste pour LÉO, d'Emma et Marc")
    assert p.vers_modele("Sophie : 06 12 34 56 78, sophie@example.com, le 2026-11-10 à 14h30") == "Parent 1 : [téléphone], [email], le 2026-11-10 à 14h30"
    assert p.vers_utilisateur("Parent 1 et Enfant 2, pas Parent 10") == "Sophie et Emma, pas Parent 10"
    assert p.prenom_de("Enfant 1") == "Léo" and p.prenom_de("Léo") is None
    assert p.fuites("Léo a rendez-vous") == ["prénom"] and not p.fuites("Enfant 1 a rendez-vous")
    assert tranche_age(8) == "6-10" and tranche_age(5) == "3-5" and tranche_age(41) == "18+"

    # Outils simulés
    cal = CalendrierSimule(donnees["famille"], donnees["calendrier_initial"], p)
    assert not cal.outil_verifier_conflits("2026-11-03T14:30", "2026-11-03T15:30", ["Parent 2"])["libre"]
    assert cal.outil_verifier_conflits("2026-11-10T16:30", "2026-11-10T17:00", ["Enfant 1"])["libre"]
    assert len(cal.outil_proposer_creneaux("2026-11-03", 60, ["Parent 2"])["creneaux"]) == 3
    assert cal.outil_rechercher_doublon("2026-11-12", "Dr Karine Benali pédiatre", type="medical")["correspondances"][0]["id"] == "evt-005"
    assert not cal.outil_rechercher_doublon("2026-11-05", "dentiste", heure="17:30", type="medical", membres=["Parent 2"])["correspondances"]
    assert cal.outil_rechercher_doublon("2026-11-10", "réunion parents", heure="18:15", membres=["Parent 1"])["correspondances"][0]["id"] == "evt-006"
    avec_auteur = CalendrierSimule(donnees["famille"], donnees["calendrier_initial"], p, auteur="Sophie")
    assert avec_auteur.outil_rechercher_doublon("2026-11-10", "réunion parents", heure="18:15", membres=["Enfant 1"])["correspondances"][0]["id"] == "evt-006", "D39 : le parent qui écrit est ajouté"
    assert not cal.outil_rechercher_doublon("2026-11-10", "réunion parents", heure="18:15", membres=["Enfant 1"])["correspondances"], "sans auteur, règle stricte"
    assert not cal.outil_rechercher_doublon("2026-11-10", "réunion parents", heure="19:00")["correspondances"], "au-delà de 30 minutes"
    assert len(cal.outil_lister_evenements("2026-11-05", "2026-11-05")["evenements"]) == 2
    vu = cal.outil_lister_evenements("2026-11-05", "2026-11-05")["evenements"][0]
    assert set(vu) <= {"id", "debut", "fin", "type", "statut", "membres", "journee_entiere"}, f"titre ou lieu transmis : {vu}"
    try:
        cal.outil_verifier_conflits("2026-11-03T14:30", "2026-11-03T15:30", ["Marc"])
        raise AssertionError("un prénom aurait dû être refusé avec la pseudonymisation")
    except ValueError:
        pass
    cree = cal.outil_creer_evenement_provisoire("Orthodontiste Dr Martin", "medical", "2026-11-06T17:00", "2026-11-06T18:00", False,
                                                ["Enfant 1"], "saisie", lieu="12 rue des Lilas", notes="radios")
    evt = cal._trouver(cree["id"])
    assert evt["titre"] == "RDV médical — Léo" and evt["lieu"] is None and evt["notes"] is None and "avis" in cree
    assert cal.developper_references("Jeudi : [[evt-003]] à 17 h.") == "Jeudi : RDV médical — Emma à 17 h.", "titre médical générique à l'affichage"
    assert cal.developper_references("Mardi : [[evt-001]], puis [[evt-999]].") == "Mardi : Réunion d'équipe, puis un rendez-vous.", "identifiant inconnu"

    # Déroulé complet sans réseau (cas 29) : alias à l'aller, prénoms au retour, aucune fuite
    cas_29 = next(c for c in donnees["cas"] if c["id"].startswith("29"))

    def ref_de_leo(messages):
        retour = json.loads(messages[-1]["content"][0]["content"])
        return next(m["ref"] for m in retour["membres"] if m["tranche_age"] == "6-10")

    scenario = _ClientScenarise([
        [_outil("t1", "lister_membres")],
        lambda m: [_outil("t2", "rechercher_doublon", date="2026-11-06", heure="17:00", type="medical", objet="orthodontiste", membres=[ref_de_leo(m)]),
                   _outil("t3", "verifier_conflits", debut="2026-11-06T17:00", fin="2026-11-06T18:00", membres=[ref_de_leo(m)])],
        lambda m: [_outil("t4", "creer_evenement_provisoire", titre="Orthodontiste", type="medical", debut="2026-11-06T17:00",
                          fin="2026-11-06T18:00", journee_entiere=False, membres=[next(
                              x["ref"] for x in json.loads(m[-3]["content"][0]["content"])["membres"] if x["tranche_age"] == "6-10")], source="saisie")],
        [_texte("C'est noté en provisoire pour Enfant 1 vendredi à 17 h (durée estimée). Vous pouvez le confirmer dans l'application.")],
    ])
    resultat = executer_cas(scenario, donnees, cas_29)
    assert resultat["erreur"] is None and not resultat["fuites"], (resultat["erreur"], resultat["fuites"])
    assert "Léo" in resultat["texte"] and "Enfant 1" not in resultat["texte"], resultat["texte"]
    assert evaluer(cas_29, resultat) == [], evaluer(cas_29, resultat)
    envoye = json.dumps(scenario.recu, default=lambda o: getattr(o, "__dict__", str(o)), ensure_ascii=False)
    assert "Léo" not in envoye and "Sophie" not in envoye, "un prénom est parti chez le modèle"
    assert "Enfant 1" in envoye
    mauvais = {**resultat, "fuites": ["prénom"]}
    assert any("données personnelles" in e for e in evaluer(cas_29, mauvais))
    avec_lieu = json.loads(json.dumps(resultat, default=str))
    avec_lieu["appels"][-1]["entree"]["lieu"] = "12 rue des Lilas"
    assert any("lieu ou notes" in e for e in evaluer(cas_29, avec_lieu))
    tutoye = {**resultat, "texte": "C'est noté, tu peux le confirmer."}
    assert any("tutoiement" in e for e in evaluer(cas_29, tutoye))
    assert remarquer({"texte": "Un. Deux. Trois. Quatre ?", "duree": 1}) and not remarquer({"texte": "Un. Deux ?", "duree": 1})
    assert remarquer({"texte": "Un.", "duree": 12.0})

    print(f"Contrôle hors ligne réussi : {len(outils)} outils, {len(ids)} cas de test, pseudonymisation, outils simulés, "
          f"évaluation et un déroulé complet sans fuite de prénom.")


# ---------------------------------------------------------------------------

def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(description="Banc d'essai de l'agent Assistant Famille")
    parser.add_argument("--cas", nargs="*", help="débuts d'identifiants de cas à lancer (ex. 04 12)")
    parser.add_argument("--verifier", action="store_true", help="contrôle hors ligne, sans appel à Claude")
    parser.add_argument("--sans-pseudo", action="store_true", help="désactive alias et minimisation (mesure de référence)")
    args = parser.parse_args()

    charger_env(RACINE / ".env")
    instructions = (RACINE / "instructions.md").read_text(encoding="utf-8")
    outils = json.loads((RACINE / "outils" / "outils.json").read_text(encoding="utf-8"))
    donnees = json.loads((RACINE / "tests" / "cas_de_test.json").read_text(encoding="utf-8"))

    if args.verifier:
        verifier_hors_ligne(donnees, outils)
        return

    cas_a_lancer = donnees["cas"]
    if args.cas:
        cas_a_lancer = [c for c in cas_a_lancer if any(c["id"].startswith(p) for p in args.cas)]
    if not cas_a_lancer:
        sys.exit("Aucun cas ne correspond à --cas")

    pseudo_actif = not args.sans_pseudo
    client, fournisseur = creer_client()
    modele = os.environ.get("MODELE", "claude-sonnet-5-5")
    effort = os.environ.get("EFFORT", "medium")
    appelant = Appelant(client, fournisseur, modele, effort, instructions, outils)

    print(f"Modèle {modele} via {fournisseur} – {len(cas_a_lancer)} cas – règles du PO {'appliquées' if pseudo_actif else 'DÉSACTIVÉES'}\n")
    resultats = []
    for cas in cas_a_lancer:
        print(f"- {cas['id']} : {cas['titre']} ...", end=" ", flush=True)
        resultat = executer_cas(appelant, donnees, cas, pseudo_actif)
        echecs = evaluer(cas, resultat)
        remarques = remarquer(resultat)
        resultats.append({**cas, **resultat, "echecs": echecs, "remarques": remarques})
        suffixe = f" – remarque : {'; '.join(remarques)}" if remarques else ""
        print(("OK" if not echecs else f"ÉCHEC ({'; '.join(echecs)})") + f" [{resultat['duree']:.1f} s]" + suffixe)

    chemin = ecrire_rapport(modele, fournisseur, resultats, pseudo_actif)
    reussis = sum(1 for r in resultats if not r["echecs"])
    print(f"\n{reussis} / {len(resultats)} cas réussis. Rapport détaillé : {chemin}")


if __name__ == "__main__":
    main()
