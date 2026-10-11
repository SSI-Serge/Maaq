"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiRequest } from "@/client/api";
import { AuthScreen, CodeEntry, ErrorLine, Heading } from "@/components/auth/parts";
import { Button, Loading } from "@/components/ui";
import styles from "@/components/auth/auth.module.css";

type Channel = "email" | "sms";
type Targets = { maskedEmail: string; maskedPhone: string | null };

/** Vérification d'identité sur un nouvel appareil (US-51), maquette Vérification. */
export default function DeviceVerificationPage() {
  const router = useRouter();
  const [targets, setTargets] = useState<Targets | null>(null);
  const [channel, setChannel] = useState<Channel>("email");
  const [code, setCode] = useState("");
  const [resendAt, setResendAt] = useState<Date | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<ApiError>();
  const [resent, setResent] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<ApiError>();
  const [next, setNext] = useState<string | null>(null);
  const firstSend = useRef(false);

  const expired = useCallback(
    (err: ApiError) => {
      if (err.body?.code === "verification_expired") router.replace("/connexion");
    },
    [router],
  );

  const send = useCallback(
    async (target: Channel, isResend: boolean) => {
      setSending(true);
      setSendError(undefined);
      setError(undefined);
      try {
        const result = await apiRequest<{ resendAvailableAt: string }>("/api/auth/device/code", {
          method: "POST",
          body: { channel: target },
        });
        setResendAt(new Date(result.resendAvailableAt));
        setResent(isResend);
      } catch (err) {
        const apiError = err as ApiError;
        const retryAt = (apiError.body?.details as { retryAt?: string } | undefined)?.retryAt;
        if (retryAt) setResendAt(new Date(retryAt));
        expired(apiError);
        setSendError(apiError);
      } finally {
        setSending(false);
      }
    },
    [expired],
  );

  useEffect(() => {
    apiRequest<Targets>("/api/auth/device")
      .then((result) => {
        setTargets(result);
        // Le code part par email dès l'arrivée sur l'écran (une seule fois).
        if (!firstSend.current) {
          firstSend.current = true;
          void send("email", false);
        }
      })
      .catch((err: ApiError) => {
        expired(err);
        setSendError(err);
      });
  }, [send, expired]);

  async function confirm() {
    setConfirming(true);
    setError(undefined);
    try {
      const result = await apiRequest<{ next: string }>("/api/auth/device/verify", { method: "POST", body: { code } });
      setNext(result.next);
    } catch (err) {
      expired(err as ApiError);
      setError(err as ApiError);
    } finally {
      setConfirming(false);
    }
  }

  if (next) {
    return (
      <AuthScreen>
        <div className={styles.form}>
          <div className={styles.success}>✓ Nouvel appareil connecté à votre compte</div>
          <Button block onClick={() => router.replace(next)}>
            Continuer
          </Button>
        </div>
      </AuthScreen>
    );
  }

  if (!targets) {
    return (
      <AuthScreen>
        {sendError ? <ErrorLine error={sendError} onRetry={() => window.location.reload()} /> : <Loading />}
      </AuthScreen>
    );
  }

  const target = channel === "email" ? `par email à ${targets.maskedEmail}` : `par SMS au ${targets.maskedPhone}`;

  return (
    <AuthScreen>
      <Heading
        eyebrow="Nouvel appareil"
        title="Vérifiez votre identité"
        lead="Nous ne reconnaissons pas cet appareil. Confirmez que c'est bien vous avec un code de vérification."
      />

      {targets.maskedPhone && (
        <div className={styles.tabs} role="tablist">
          {(["email", "sms"] as const).map((c) => (
            <button
              key={c}
              type="button"
              role="tab"
              aria-selected={channel === c}
              disabled={sending}
              className={`${styles.tab} ${channel === c ? styles.tabActive : ""}`}
              onClick={() => {
                if (channel === c) return;
                setChannel(c);
                setCode("");
                setResendAt(null);
                void send(c, false);
              }}
            >
              {c === "email" ? "Par email" : "Par SMS"}
            </button>
          ))}
        </div>
      )}

      <p className={styles.lead} style={{ marginBottom: 14 }}>
        {sending ? "Envoi du code…" : `Code envoyé ${target}`}
      </p>
      {sendError && sendError.body?.code !== "code_cooldown" && <ErrorLine error={sendError} onRetry={() => send(channel, true)} />}

      <CodeEntry
        code={code}
        onCode={setCode}
        onConfirm={confirm}
        confirming={confirming}
        onResend={() => send(channel, true)}
        resending={sending}
        resendAvailableAt={resendAt}
        error={error}
        resent={resent}
      />
      <p className={styles.note} style={{ marginTop: 18 }}>
        Cette vérification n&apos;est demandée qu&apos;une fois par appareil. Ensuite, votre schéma tactile suffit.
      </p>
    </AuthScreen>
  );
}
