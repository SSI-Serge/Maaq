"use client";

import { Component, type ReactNode } from "react";

/**
 * Enveloppe d'une section facultative (suivi du trajet, « Sur place »…) : si son affichage échoue, seule la section disparaît, avec un mot d'explication, et le reste de l'écran
 * (confirmer, modifier, annuler un RDV) continue de fonctionner. Une fonction facultative ne doit jamais empêcher d'ajouter ou de gérer un rendez-vous.
 */
export class OptionalSection extends Component<{ label: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    console.error(`Section « ${this.props.label} » indisponible : ${error.message}`);
  }

  render() {
    return this.state.failed ? <p style={{ margin: 0, fontSize: 12, opacity: 0.7 }}>« {this.props.label} » n&apos;est pas disponible pour le moment.</p> : this.props.children;
  }
}
