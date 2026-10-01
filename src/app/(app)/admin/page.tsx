import { redirect } from "next/navigation";

/** L'administrateur arrive sur l'administration des agents (US-3 RF6). */
export default function AdminIndex() {
  redirect("/admin/agents");
}
