import styles from "./admin.module.css";

export type AccountStatus = "activation_pending" | "active" | "grace_period";

/** Statut d'un compte tel qu'affiché dans la console (US-64 RF1). */
export const ACCOUNT_STATUS: Record<AccountStatus, { label: string; tone: string }> = {
  activation_pending: { label: "Activation en attente", tone: styles.badgeWarn },
  active: { label: "Actif", tone: styles.badgeOk },
  grace_period: { label: "En délai de grâce", tone: styles.badgeError },
};
