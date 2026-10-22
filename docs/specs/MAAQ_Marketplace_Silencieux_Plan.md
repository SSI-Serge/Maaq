# Maaq silent marketplace — implementation plan

Status: **confirmed on 2026-10-21**; Phase 1 built on `ulrichagents` (see `Vitrine-agent/README.md`). Based on the user stories US-01 to US-17 and on the way MAAQ runs agents today (kdo_help). The decisions in section 3 were confirmed with the clickable mock.

## 1. The feature in one paragraph

A supplier (a MAAQ profile, in the **Pro** area) tells a MAAQ agent what they do, by voice or text. The agent turns that into a structured, confirmed storefront record that the supplier reviews and explicitly publishes. A buyer (any MAAQ profile, in the **Perso** area) either asks their agent for a service or, if they opted in, receives a suggestion at a relevant moment. A suggestion names the provider, the service, the area and the price information, and says why it appears. If the buyer is interested, MAAQ shows exactly what would be sent to the supplier and asks for approval. Only then is the supplier notified; the supplier accepts, declines or asks a question, and the two sides are connected through the contact method the supplier chose. Nobody browses a marketplace, nothing is shared without a yes, and no agent promises a price, a slot or an availability the supplier has not confirmed.

## 2. How it maps onto MAAQ as built

What already exists and is reused as-is:

| Need | Existing piece | Where |
|---|---|---|
| Agent runtime (system prompt, Zod tools, tool loop, failure message) | `AgentBrain` + `anthropicLlm` + Digitorn simulator delegating to brains | `src/server/agents/`, `src/server/adapters/digitorn/mock.ts` |
| Agent published in the catalog, added to a dashboard, chat screen, daily cap, logbook, erasure, export | catalog + chat services, `ChatScreen` | `src/server/catalog/`, `src/server/chat/`, `src/components/chat/` |
| "Ask before doing" cards (Valider / Refuser), also on WhatsApp | `BrainProposal` → `ActionProposal` (US-39) | `mock.ts`, `ActionCard.tsx`, `channels/render.ts` |
| Proactive message from an agent into a user's chat | `postAgentMessage` (used by gift reminders) | `jobs.ts`, `gifts/reminders.ts` |
| WhatsApp channel: linking, opt-in, 24 h window, templates, quick-reply buttons | `channels/whatsapp-core.ts`, `adapters/whatsapp/` | |
| Voice input in the browser (2 min, live transcription, editable text, audio never sent) | `Dictation` component (US-63 support form) | `src/components/settings/Dictation.tsx` |
| Per-agent extra screen on the agent sheet (kdo_help calendar) | `catalogue/[id]/page.tsx` branches on `digitornRef` | |
| Admin console pages and audit log | `admin/*` | |
| Periodic jobs | `runDueJobs` | `src/server/jobs.ts` |
| Test harness: fake LLM replaying tool calls, memory stores, real-DB tests, evals | `tests/helpers/fake-llm.ts`, `scripts/eval-kdo-help.ts` | |

What is new in kind, not just in code:

1. **Cross-account visibility.** Today an account is the data isolation boundary. A published storefront is the first record deliberately readable by other accounts. The plan keeps that exception narrow: only the published, confirmed, buyer-visible fields of a `published` storefront leave the account; the buyer's need leaves only in the approved introduction text.
2. **Two profiles talking through MAAQ.** There is no user-to-user messaging. The introduction is a state machine with MAAQ relaying fixed, approved payloads, not a chat between two people.
3. **Persistent conversation state.** The simulator keeps chat history in memory (4 days, lost on restart). The storefront draft and every marketplace state therefore live in the database from the first turn, like kdo_help's people and occasions. "Leave and resume" (US-01) and "switch voice/text without losing progress" come for free from that.

## 3. Design decisions and assumptions [to confirm]

1. **Two agents, not one.** `vitrine` in Pro (supplier side: create, review, publish, pause, answer introductions) and a buyer agent in Perso (ask for a service, receive suggestions, approve introductions). Names are placeholders. One agent with two faces would fight the catalog model (one category per agent, one chat per profile+agent).
2. **Matching is a service, not a second LLM agent.** Eligibility is SQL on the structured record; relevance is one structured LLM call (`complete` with a Zod schema) that scores and explains each eligible candidate against the need. US-15's "store agent answers using the listing" is satisfied by the matcher reading the confirmed record. No free-form agent-to-agent talk in v1, as the story's architecture note allows.
3. **Area matching by French département for the MVP.** Supplier gives a city and postcode (never a street); the record stores the postcode, the city label and the mode(s): customers come, supplier travels, remote. Eligibility: same département (first two digits, Corsica and overseas handled), or supplier lists extra départements they travel to, or remote. Radius/geocoding later, with a commune table.
4. **Hours are not required.** "By arrangement" is a valid, honest value (the story's open choice). Availability is shown as given, never inferred.
5. **Voice = browser speech recognition, as today.** The `Dictation` component is generalised into a mic button in the chat input for local agents. No server-side transcription, no audio stored, no WhatsApp voice notes (the channel already replies that it cannot listen). Low-confidence handling (US-04): instead of relying on the API's confidence value, the agent always reads back price, location and contact details before marking them confirmed.
6. **"Connected" means a contact exchange, not a relayed chat.** When the supplier accepts, each side receives the other's chosen contact detail (phone, email, or a WhatsApp link) and the introduction is closed as connected.
7. **Explicit buyer requests first; agenda-triggered suggestions deferred.** US-09's consent screen is built with the "use my agenda" switch present but inactive (labelled as coming), so the consent model is right from day one. Google Calendar reading is a later phase.
8. **Photos deferred.** No user file storage today outside contract documents sent to Drive. The record has a `photos` slot left empty.
9. **No ratings in the MVP** (US-14 rule 4), no public search: storefronts are `suggested_only` by default, with the "searchable" flag stored but unused.
10. **Suggestions do not count against the daily request cap** (they are agent-initiated), and a dismissed storefront is not suggested again to that buyer for 90 days [to confirm the number].

## 4. Data model (migration `0008_marketplace.sql`)

Numbering checked against `origin/test` (latest there is 0006; `ulrichagents` has 0007). All tables cascade on user deletion and are included in the profile export, like `gift_*`.

- `service_categories` — seeded reference list (code, label, sort). Free-text services sit inside the storefront; the category is what eligibility filters on. Admin can remap (US-17).
- `storefronts` — one per profile. `status` (draft | published | paused), `display_name`, `category_code`, `services jsonb` (list of short strings), `description`, `postcode`, `city`, `modes jsonb` (at_supplier / travels / remote), `travel_areas jsonb` (extra départements), `availability_mode` (hours | by_arrangement), `availability_text`, `price_mode` (quote | from | range), `price_min`, `price_max`, `languages jsonb`, `notice_text`, `qualifications_text`, `contact_method` (maaq_intro | whatsapp), `contact_value_encrypted` (what is revealed on connection), `paused_until`, `searchable boolean default false`, `confirmed jsonb` (field → timestamp of the supplier's confirmation), `proposed jsonb` (candidate values the agent extracted but the supplier has not confirmed), `last_confirmed_at`, `published_at`, `version`, timestamps. Publication requires every required field confirmed (checked in the service, mirrored by a DB function for the eligibility view).
- `v_eligible_storefronts` — view: published, not paused, required fields confirmed, contact method set. The one record the matcher reads (US-13).
- `service_requests` — buyer need: `user_id`, `text`, `category_code`, `postcode`, `timing_text`, `status` (open | suggested | closed), `notify_later boolean`, timestamps.
- `suggestions` — `request_id` (nullable for proactive ones), `buyer_user_id`, `storefront_id`, `reason` (plain-language, buyer-facing), `internal_reason` (eligibility + relevance explanation, operator-facing), `score`, `status` (shown | interested | dismissed | muted | expired), `shown_at`. Unique active pair (buyer, storefront); cooldown after dismissal.
- `introductions` — `suggestion_id`, `buyer_user_id`, `storefront_id`, `shared_text` (exactly what the buyer approved), `channel`, `status` (requested | accepted | declined | question | connected | expired), `supplier_message`, `requested_at`, `answered_at`, `connected_at`. One open introduction per (buyer, storefront).
- `marketplace_prefs` — per user: `suggestions_opt_in`, `agenda_opt_in` (stored, inactive), `muted_categories jsonb`, `opt_in_at`, `consent_version`.
- `listing_reports` — reporter, storefront, category of problem, comment, status (open | reviewed | dismissed), admin decision, timestamps (US-16).

## 5. Agents and tools

### `vitrine` (Pro) — supplier agent

System prompt in French like kdo_help: extract, never invent, show what was understood, one question at a time, read back critical details, distinguish "you said" from "I suggest", never publish from the conversation.

Tools: `lire_vitrine`, `proposer_champs` (writes to `proposed`, returns a readable summary), `confirmer_champs` (moves listed fields from `proposed` to confirmed; price/location/contact only after an explicit read-back turn), `champs_manquants`, `mettre_en_pause` / `reprendre`, `indisponible_jusqu_au`, `lister_introductions`, `repondre_introduction` (accept | decline | question → proposal card, since it releases contact details), `apercu_suggestion` (how a buyer would see it). Publishing is **not** a tool: it is a button on the review screen (US-05).

### Buyer agent (Perso)

Tools: `demander_service` (creates a `service_request`, asks for category / area / timing only when they materially change matching), `chercher` (calls the matcher, returns suggestions with reasons, or an honest "no suitable provider" plus the notify-later option), `voir_vitrine`, `interesse` (drafts the shared text and returns it as a proposal card "Envoyer cette présentation à X ?" — the card is the approval), `ignorer`, `couper_suggestions` (category or all), `statut_introductions`.

### Matcher (`src/server/marketplace/matching.ts`)

1. Eligibility (SQL, deterministic, explainable): `v_eligible_storefronts` ∩ category ∩ area rule ∩ not muted ∩ no active suggestion/intro with this buyer ∩ cooldown.
2. Relevance (one `complete` call, Zod schema): for at most N candidates, a fit score 0–1, a buyer-facing reason, and a flag when the fit is uncertain. Below a threshold the candidate is withheld; between thresholds it is framed as a question ("Peut-être X, qui fait Y — est-ce le genre de service que vous cherchez ?").
3. Practicality is only stated when known: unknown availability is shown as "à convenir", never as free.

Every decision step is written into `suggestions.internal_reason` so an operator can inspect why without reading the chat (US-17).

## 6. Flows

**Storefront creation.** Supplier adds `vitrine` from the Pro catalog → chat opens with the explanation and three first suggestions ("Décrire mon activité", "Reprendre ma vitrine", "Voir ce qu'il manque") → supplier speaks or types → agent extracts to `proposed`, replies with "Voici ce que j'ai compris…", asks the next missing thing → read-back on price/location/contact → the agent sheet (Catalogue › vitrine) shows the review screen: every buyer-visible field, missing optional ones, inline edit, "Aperçu côté acheteur", and **Publier** (disabled until required fields are confirmed). The same screen holds Pause / Reprendre and the temporary-unavailability date.

**Request → suggestion → introduction → handoff.**
1. Buyer asks the Perso agent ("Je cherche quelqu'un pour des tresses à Lyon samedi") or a job runs an open request flagged notify-later.
2. Matcher returns ranked suggestions; agent shows at most 3, each with provider, service, area, price info ("Sur devis" when unset) and the reason.
3. Buyer says "intéressé" → agent builds the shared text (service wanted, approximate timing and area, buyer first name, chosen channel) → proposal card. Buyer can ask to edit it before validating. No card validated, nothing sent.
4. Validation creates the `introduction` (requested) and posts a message into the supplier's `vitrine` chat; if the supplier has WhatsApp linked and opted in, a template message with buttons Accepter / Refuser / Question goes out too (new template, to submit to Meta).
5. Supplier answers; MAAQ updates the status and tells the buyer. On accept, both sides receive the contact detail the supplier chose; status connected. Declined or unanswered after 7 days → expired, and the pair is not re-introduced for 90 days.

Both chats can ask for status at any time; every transition is a row, never a free-text memory.

## 7. Build phases

### Phase 1 — Storefront foundation (US-01 to 06, US-13)

- Migration 0008 (storefront, categories, prefs skeleton, eligibility view).
- `src/server/marketplace/`: `model.ts` (fields, required list, validation, département rule), `store.ts` (interface + memory), `db-store.ts`, `service.ts` (publish, pause, preview, export hook).
- `src/server/agents/vitrine.ts` + `vitrine-tools.ts`; registered in `localBrains()`.
- Seed: `vitrine` agent in Pro with examples and first suggestions; service categories.
- API: `/api/storefront` (GET, PATCH field, POST publish, POST pause/resume, GET preview).
- UI: review screen on the agent sheet (`src/components/marketplace/StorefrontReview.tsx`); mic button in `ChatScreen` reusing `Dictation`'s recognition; switch voice/text keeps the draft.
- Tests: tool-level with fake LLM (extraction never invents: "I can travel on Saturdays" stays Saturday-only), publish gate, pause excludes from the view, resume after leaving, DB round trip. Eval set `Vitrine-agent/evals/golden.json` with a handful of spoken-style descriptions.
- Docs: `Vitrine-agent/README.md` in the style of `Kdo-agent/`.

### Phase 2 — Controlled matching pilot (US-09 to 12, US-14)

- Tables `service_requests`, `suggestions`, `introductions` (part of 0008 or a 0009 if phase 1 ships first).
- `matching.ts` with eligibility + relevance + explanations; thresholds as constants in `rules.ts`.
- Buyer agent brain + tools; seeded in Perso.
- Consent screen Réglages › Suggestions de services (opt in/out, mute, agenda switch inactive); link from the buyer agent's gate when not opted in.
- Interest → proposal card → introduction (requested); statuses visible in both chats.
- Tests: eligibility explains itself; out-of-area never shown as local; unknown availability never shown as confirmed; low score withheld; dismissal cooldown; no fabricated match on empty results.

### Phase 3 — Agent handoff (US-07, 08, 15)

- Supplier contact preferences on the review screen; what is shared at each step spelled out in the UI and in the agent's text.
- Supplier notification: in-app via `postAgentMessage`, WhatsApp template + buttons; `repondre_introduction` tool and button parsing in `whatsapp-core.ts`.
- Contact exchange on accept; expiry job in `runDueJobs`; audit of every transition.
- Tests: no contact detail leaves before accept; one open introduction per pair; WhatsApp buttons map to the same transitions as the chat.

### Phase 4 — Scale and quality (US-16, 17)

- Report a listing from a suggestion or storefront view; admin page Admin › Vitrines (by status, reported first, pause/unpause, remap category, read `internal_reason`), counters: completed storefronts, eligible listings by area and category, suggestions shown, interest, introductions accepted, dismissed.

## 8. Out of the first release

Public search, ratings, agenda-triggered suggestions, photos, server-side transcription, WhatsApp voice notes, automated booking, paid ranking, radius matching, relayed chat between buyer and supplier.

## 9. Risks and open points

- **Meta template approval** for the introduction notification takes days and can be refused; in-app delivery is the baseline, WhatsApp an addition.
- **Browser speech recognition** is uneven (good on Chrome/Android, partial on iOS Safari): text must always work equally well, which the design guarantees.
- **Thin supply.** With few storefronts, honest "no provider" answers will be frequent; the notify-later request keeps the buyer's need without faking a match.
- **Legal text.** The consent for proactive suggestions and the cross-account visibility of a published storefront should be reflected in the privacy policy versions (`legal_document_versions`) before the pilot.
- **Digitorn.** Like kdo_help, these agents run in MAAQ's simulator even in live mode; moving them to Digitorn later means porting prompts and tools, not the data model.
