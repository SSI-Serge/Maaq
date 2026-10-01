"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiError, apiRequest } from "@/client/api";
import {
  deviceTimezone,
  fetchAuthState,
  flushPendingLogout,
  formatLocalTime,
  rememberedEmail,
  useRememberedEmail,
  type AuthState,
} from "@/client/auth";
import { AuthScreen, ErrorLine, Heading } from "@/components/auth/parts";
import { PatternLockedNotice, PatternUnlock } from "@/components/auth/PatternUnlock";
import { Button, Field, Loading, Notice } from "@/components/ui";
import styles from "@/components/auth/auth.module.css";

const EMAIL_FORMAT = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

type Tab = "password" | "pattern";

/** Écran de connexion (US-3) avec l'onglet de déverrouillage par schéma (US-6), maquette Connexion. */
export default function LoginPage() {
  const router = useRouter();
  const [state, setState] = useState<AuthState | null>(null);
  const [tab, setTab] = useState<Tab>("password");
  const [patternLocked, setPatternLocked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Une déconnexion restée en attente est d'abord renvoyée (US-9 RF8).
      const loggedOut = await flushPendingLogout();
      const current = await fetchAuthState().catch(() => null);
      if (cancelled) return;
      if (current?.authenticated && loggedOut) {
        if (current.unlocked) return router.replace(current.home);
        if (current.user.role !== "admin" && current.device.hasPattern) {
          setTab("pattern");
          setPatternLocked(current.device.patternLocked);
        }
      }
      setState(loggedOut ? current : { authenticated: false, pendingVerification: false });
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (!state) {
    return (
      <AuthScreen>
        <Loading />
      </AuthScreen>
    );
  }

  const canUsePattern = state.authenticated && state.user.role !== "admin" && state.device.hasPattern;

  return (
    <AuthScreen>
      <Heading title="Bienvenue" lead="Vos agents IA pour l'administratif et le quotidien, en toute transparence." />

      <div className={styles.tabs} role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "password"}
          className={`${styles.tab} ${tab === "password" ? styles.tabActive : ""}`}
          onClick={() => setTab("password")}
        >
          Mot de passe
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "pattern"}
          disabled={!canUsePattern}
          title={canUsePattern ? undefined : "Aucun schéma tactile n'est enregistré sur cet appareil"}
          className={`${styles.tab} ${tab === "pattern" ? styles.tabActive : ""}`}
          onClick={() => setTab("pattern")}
        >
          Schéma tactile
        </button>
      </div>

      {tab === "password" && <PasswordForm onSuccess={(next) => router.replace(next)} />}

      {tab === "pattern" && state.authenticated && !patternLocked && (
        <PatternUnlock
          firstName={state.user.firstName}
          maskedEmail={state.user.maskedEmail}
          onUnlocked={(next) => router.replace(next)}
          onLocked={() => setPatternLocked(true)}
          onUsePassword={() => setTab("password")}
        />
      )}
      {tab === "pattern" && patternLocked && <PatternLockedNotice onUsePassword={() => setTab("password")} />}
    </AuthScreen>
  );
}

function PasswordForm({ onSuccess }: { onSuccess: (next: string) => void }) {
  const [email, setEmail] = useRememberedEmail();
  const [password, setPassword] = useState("");
  const [emailError, setEmailError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError>();

  const complete = email.trim() !== "" && password !== "";
  const lockedUntil = error?.body?.code === "login_locked" ? (error.body.details as { until: string }).until : null;
  const stillLocked = lockedUntil !== null && new Date(lockedUntil) > new Date();

  async function submit(event?: React.FormEvent) {
    event?.preventDefault();
    if (!complete || pending) return;
    if (!EMAIL_FORMAT.test(email.trim())) return setEmailError("Adresse email invalide");
    setPending(true);
    setError(undefined);
    try {
      const result = await apiRequest<{ next: string }>("/api/auth/login", {
        method: "POST",
        body: { email: email.trim(), password, timezone: deviceTimezone() },
      });
      rememberedEmail.set(email);
      onSuccess(result.next);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setPending(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <Field
        label="Adresse email"
        type="email"
        autoComplete="username"
        placeholder="vous@exemple.fr"
        value={email}
        error={emailError}
        onChange={(event) => {
          setEmail(event.target.value);
          setEmailError(undefined);
        }}
        onBlur={() => email.trim() && !EMAIL_FORMAT.test(email.trim()) && setEmailError("Adresse email invalide")}
      />
      <Field
        label="Mot de passe"
        type="password"
        autoComplete="current-password"
        placeholder="••••••••"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
      />
      <Link href="/mot-de-passe-oublie" className={`${styles.link} ${styles.linkEnd}`}>
        Mot de passe oublié ?
      </Link>

      {stillLocked ? (
        <Notice tone="error">Trop de tentatives. Réessayez à partir de {formatLocalTime(lockedUntil)}.</Notice>
      ) : (
        error?.body?.code !== "login_locked" && <ErrorLine error={error} onRetry={() => submit()} />
      )}

      <Button type="submit" block loading={pending} disabled={!complete || stillLocked} style={{ marginTop: 6 }}>
        Se connecter
      </Button>
    </form>
  );
}
