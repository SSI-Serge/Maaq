"use client";

import { Suspense } from "react";
import { CoursesMenuScreen } from "@/components/courses/MenuScreen";

/** « Menu de la semaine » de Courses et repas (US-155, US-156). */
export default function CoursesMenuPage() {
  return (
    <Suspense fallback={null}>
      <CoursesMenuScreen />
    </Suspense>
  );
}
