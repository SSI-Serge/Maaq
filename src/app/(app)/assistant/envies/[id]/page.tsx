"use client";

import { useParams } from "next/navigation";
import { WishFormScreen } from "@/components/family/WishesScreens";

/** « Modifier l'envie » (US-148 RF4). */
export default function EditWishPage() {
  const { id } = useParams<{ id: string }>();
  return <WishFormScreen id={id} />;
}
