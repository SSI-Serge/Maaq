"use client";

import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, SESSION_EVENTS, apiRequest } from "@/client/api";
import { fetchAuthState, signOut, type AuthState } from "@/client/auth";
import { Button, Field, Logo, Notice, RetryNotice, Screen } from "@/components/ui";
import styles from "./auth.module.css";
import { ErrorLine, LockIcon } from "./parts";
import { PatternLockedNotice, PatternUnlock } from "./PatternUnlock";

type SignedIn = Extract<AuthState, { authenticated: true }>;

const SessionContext = createContext<SignedIn | null>(null);

/** Profil connecté, pour les écrans protégés. */
export function useSessionUser(): SignedIn["user"] {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSessionUser doit être utilisé sous <AuthGate>");
  return session.user;
}

const IDLE_MS = 5 * 60_000;
const CHECK_EVERY_MS = 10_000;
const HEARTBEAT_MS = 60_000;

/**
 * Garde des écrans protégés :
 *  - sans session → écran de connexion ;
 *  - session verrouillée (lancement ou inactivité) → écran de déverrouillage posé au-dessus ;
 *  - redirections obligatoires (création du schéma, reprise de compte, configuration initiale).
 * Le contenu reste monté sous l'écran verrouillé : on retrouve l'écran et la saisie en cours (US-52 RF3).
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = useState<AuthState | null>(null);
  const [error, setError] = useState<ApiError>();
  const [everUnlocked, setEverUnlocked] = useState(false);
  const [reason, setReason] = useState<"launch" | "idle">("launch");

  const apply = useCallback((next: AuthState) => {
    setError(undefined);
    setState(next);
    if (next.authenticated && next.unlocked) setEverUnlocked(true);
  }, []);
  const fail = useCallback((err: unknown) => setError(err as ApiError), []);
  const load = useCallback(() => fetchAuthState().then(apply, fail), [apply, fail]);

  useEffect(() => {
    fetchAuthState().then(apply, fail);
  }, [apply, fail]);

  // Redirections selon l'état de la session.
  useEffect(() => {
    if (!state) return;
    if (!state.authenticated) return router.replace("/connexion");
    if (!state.unlocked) return;
    const target = forcedDestination(state, pathname);
    if (target && target !== pathname) router.replace(target);
  }, [state, pathname, router]);

  const lock = useCallback((tellServer: boolean) => {
    setReason("idle");
    setState((previous) => (previous?.authenticated ? { ...previous, unlocked: false } : previous));
    if (tellServer) void apiRequest("/api/auth/lock", { method: "POST" }).catch(() => {});
  }, []);

  useEffect(() => {
    const onLocked = () => lock(false);
    const onSignedOut = () => router.replace("/connexion");
    window.addEventListener(SESSION_EVENTS.locked, onLocked);
    window.addEventListener(SESSION_EVENTS.signedOut, onSignedOut);
    return () => {
      window.removeEventListener(SESSION_EVENTS.locked, onLocked);
      window.removeEventListener(SESSION_EVENTS.signedOut, onSignedOut);
    };
  }, [lock, router]);

  const unlocked = state?.authenticated === true && state.unlocked;
  useInactivityLock(unlocked, () => lock(true));

  if (!state) {
    return (
      <Screen centered>
        {error ? <RetryNotice message={error.message} onRetry={load} /> : <Logo size="large" pulse />}
      </Screen>
    );
  }
  if (!state.authenticated) return <Screen centered><Logo size="large" pulse /></Screen>;

  return (
    <SessionContext.Provider value={state}>
      {everUnlocked && (
        <div className={unlocked ? undefined : styles.hiddenContent} aria-hidden={!unlocked}>
          {children}
        </div>
      )}
      {!unlocked && (
        <div className={styles.lockLayer}>
          <LockScreen
            state={state}
            reason={reason}
            onUnlocked={load}
            onPatternLocked={() =>
              setState((previous) =>
                previous?.authenticated ? { ...previous, device: { ...previous.device, patternLocked: true } } : previous,
              )
            }
          />
        </div>
      )}
    </SessionContext.Provider>
  );
}

/** Écran imposé avant tout le reste, ou espace réservé au rôle (administration / application). */
function forcedDestination(state: SignedIn, pathname: string): string | null {
  const home = state.home;
  if (home === "/schema/creer" || home === "/reprise-compte") return pathname === home ? null : home;
  if (pathname === "/reglages") return null; // accessible à tous, pour pouvoir se déconnecter
  if (home === "/configuration") return pathname === home ? null : home;
  if (pathname === "/reprise-compte") return home;
  const isAdminArea = pathname.startsWith("/admin");
  if (state.user.role === "admin" && !isAdminArea) return home;
  if (state.user.role !== "admin" && isAdminArea) return home;
  return null;
}

/**
 * Verrouillage après 5 minutes sans toucher, saisie ni défilement, y compris quand l'application
 * est restée en arrière-plan ou que le téléphone s'est mis en veille (US-52 RF1, RF2, RT1).
 */
function useInactivityLock(active: boolean, onIdle: () => void) {
  const lastActivity = useRef(0);
  const lastBeat = useRef(0);
  const onIdleRef = useRef(onIdle);

  useEffect(() => {
    onIdleRef.current = onIdle;
  }, [onIdle]);

  useEffect(() => {
    if (!active) return;
    lastActivity.current = Date.now();
    lastBeat.current = Date.now();
    const touch = () => {
      lastActivity.current = Date.now();
    };
    const check = () => {
      const now = Date.now();
      if (now - lastActivity.current >= IDLE_MS) return onIdleRef.current();
      // Le serveur garde le déverrouillage tant que l'appareil signale une activité récente.
      if (lastActivity.current > lastBeat.current && now - lastBeat.current >= HEARTBEAT_MS) {
        lastBeat.current = now;
        void apiRequest("/api/auth/activity", { method: "POST" }).catch(() => {});
      }
    };
    const onVisible = () => document.visibilityState === "visible" && check();
    const events = ["pointerdown", "keydown", "touchstart", "wheel", "scroll"] as const;
    events.forEach((name) => window.addEventListener(name, touch, { passive: true, capture: true }));
    document.addEventListener("visibilitychange", onVisible);
    const timer = setInterval(check, CHECK_EVERY_MS);
    return () => {
      events.forEach((name) => window.removeEventListener(name, touch, { capture: true }));
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(timer);
    };
  }, [active]);
}

function LockScreen({
  state,
  reason,
  onUnlocked,
  onPatternLocked,
}: {
  state: SignedIn;
  reason: "launch" | "idle";
  onUnlocked: () => void;
  onPatternLocked: () => void;
}) {
  const router = useRouter();
  const usePassword = () => router.push("/connexion");

  if (state.user.role === "admin") return <AdminUnlock maskedEmail={state.user.maskedEmail} onUnlocked={onUnlocked} />;

  if (state.device.patternLocked) {
    return (
      <Screen>
        <PatternLockedNotice onUsePassword={usePassword} />
      </Screen>
    );
  }

  if (!state.device.hasPattern) {
    return (
      <Screen centered>
        <LockIcon />
        <p className={styles.lead}>Aucun schéma tactile n&apos;est enregistré sur cet appareil. Connectez-vous avec votre mot de passe.</p>
        <Button onClick={usePassword}>Se connecter</Button>
      </Screen>
    );
  }

  return (
    <Screen>
      {reason === "idle" ? (
        <div style={{ textAlign: "center", marginBottom: 18 }}>
          <LockIcon />
          <h1 className={styles.title}>MAAQ est verrouillé</h1>
          <p className={styles.lead} style={{ margin: 0 }}>
            Verrouillage automatique après 5 minutes d&apos;inactivité. Reproduisez votre schéma pour continuer.
          </p>
        </div>
      ) : (
        <div className={styles.header}>
          <Logo />
        </div>
      )}
      <PatternUnlock
        firstName={state.user.firstName}
        maskedEmail={state.user.maskedEmail}
        onUnlocked={onUnlocked}
        onLocked={onPatternLocked}
        onUsePassword={usePassword}
      />
      {reason === "idle" && (
        <p className={styles.note} style={{ marginTop: 18 }}>
          Le verrouillage n&apos;est pas une déconnexion : vos conversations en cours sont conservées.
        </p>
      )}
    </Screen>
  );
}

/** Déverrouillage de l'administrateur par mot de passe (US-52 RF8), maquette Console verrouillée. */
function AdminUnlock({ maskedEmail, onUnlocked }: { maskedEmail: string; onUnlocked: () => void }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError>();

  async function unlock(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    try {
      await apiRequest("/api/auth/unlock/password", { method: "POST", body: { password } });
      setPassword("");
      onUnlocked();
    } catch (err) {
      setPassword("");
      setError(err as ApiError);
    } finally {
      setPending(false);
    }
  }

  return (
    <Screen>
      <form className={styles.form} onSubmit={unlock}>
        <Logo />
        <div>
          <h1 className={styles.title} style={{ marginTop: 24 }}>
            Application verrouillée
          </h1>
          <p className={styles.lead}>Votre session a été verrouillée après 5 minutes d&apos;inactivité.</p>
        </div>
        <Field label="Email" type="email" value={maskedEmail} disabled readOnly />
        <Field
          label="Mot de passe"
          type="password"
          autoComplete="current-password"
          placeholder="••••••••"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error?.body?.code === "login_locked" ? (
          <Notice tone="error">Trop de tentatives. Réessayez dans 15 minutes.</Notice>
        ) : (
          <ErrorLine error={error} />
        )}
        <Button type="submit" block loading={pending} disabled={!password}>
          Déverrouiller
        </Button>
        <button
          type="button"
          className={styles.link}
          style={{ alignSelf: "center" }}
          onClick={async () => {
            await signOut();
            router.replace("/connexion");
          }}
        >
          Se déconnecter
        </button>
      </form>
    </Screen>
  );
}
