import { afterEach, describe, expect, it, vi } from "vitest";
import { forcedDestination, presentationSkip, retryPresentationSeen, withPresentationSkip, type AuthState } from "@/client/auth";

type SignedIn = Extract<AuthState, { authenticated: true }>;

const stateOf = (home: string, extra: Partial<SignedIn> = {}): SignedIn => ({
  authenticated: true,
  unlocked: true,
  user: { firstName: "Camille", maskedEmail: "c***@example.fr", role: "primary_user", guestRank: null },
  device: { hasPattern: true, patternLocked: false },
  home,
  ...extra,
});

afterEach(() => {
  presentationSkip.clear();
  vi.unstubAllGlobals();
});

describe("« Découvrir MAAQ » : « Passer » et « Continuer » ne ramènent jamais sur la vidéo (US-140 RF4, RF8)", () => {
  it("cause de la boucle : la garde qui garde l'état d'avant l'enregistrement renvoie sur la vidéo, la garde relue laisse passer", () => {
    // La garde de l'espace connecté lit l'état à l'ouverture de l'écran (vidéo à voir) et ne le relit pas toute seule.
    const stale = stateOf("/decouvrir");
    expect(forcedDestination(stale, "/accueil")).toBe("/decouvrir");
    expect(forcedDestination(stale, "/configuration")).toBe("/decouvrir");
    // Après « vu » et relecture : l'accueil pour un parent configuré, la configuration sinon.
    expect(forcedDestination(stateOf("/accueil"), "/accueil")).toBeNull();
    expect(forcedDestination(stateOf("/configuration"), "/configuration")).toBeNull();
    expect(forcedDestination(stateOf("/configuration"), "/accueil")).toBe("/configuration");
  });

  it("un invité relu arrive sur l'accueil, l'administrateur n'est jamais renvoyé sur la vidéo", () => {
    const guest = stateOf("/accueil", { user: { firstName: "Élodie", maskedEmail: "e***@example.fr", role: "guest", guestRank: "core" } });
    expect(forcedDestination(guest, "/accueil")).toBeNull();
    const admin = stateOf("/admin/agents", { user: { firstName: "Admin", maskedEmail: "a***@example.fr", role: "admin", guestRank: null } });
    expect(forcedDestination(admin, "/admin/agents")).toBeNull();
  });

  it("enregistrement en échec : l'appareil suit la destination suivante au lieu de la vidéo (reconnexion comprise)", () => {
    const serverSays = stateOf("/decouvrir", { homeAfterPresentation: "/configuration" });
    // Rien n'a échoué : la vidéo reste proposée.
    expect(withPresentationSkip(serverSays, false)).toBe(serverSays);
    // Échec retenu : le serveur dit toujours « vidéo à voir », l'appareil passe.
    const followed = withPresentationSkip(serverSays, true) as SignedIn;
    expect(followed.home).toBe("/configuration");
    expect(forcedDestination(followed, "/accueil")).toBe("/configuration");
    expect(forcedDestination(withPresentationSkip(stateOf("/decouvrir", { homeAfterPresentation: "/accueil" }), true) as SignedIn, "/accueil")).toBeNull();
  });

  it("le contournement ne touche ni une autre destination, ni une session sans suite connue, ni une session fermée", () => {
    const conditions = stateOf("/conditions", { homeAfterPresentation: "/accueil" });
    expect(withPresentationSkip(conditions, true)).toBe(conditions);
    const unknown = stateOf("/decouvrir");
    expect(withPresentationSkip(unknown, true)).toBe(unknown);
    const out: AuthState = { authenticated: false, pendingVerification: false };
    expect(withPresentationSkip(out, true)).toBe(out);
  });

  it("l'échec est retenu pour la session, puis oublié une fois l'enregistrement réussi en arrière-plan", async () => {
    expect(presentationSkip.active()).toBe(false);
    presentationSkip.set();
    expect(presentationSkip.active()).toBe(true);

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ seen: true }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    retryPresentationSeen();
    await vi.waitFor(() => expect(presentationSkip.active()).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/presentation/seen");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "POST" });

    // Plus rien à retenter : aucun nouvel appel.
    retryPresentationSeen();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("si le nouvel essai échoue encore, l'appareil continue de laisser passer", async () => {
    presentationSkip.set();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 403, headers: { "Content-Type": "application/json" } })));
    retryPresentationSeen();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(presentationSkip.active()).toBe(true);
  });
});
