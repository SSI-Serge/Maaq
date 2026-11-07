"use client";

import { Suspense } from "react";
import { CoursesConsole } from "@/components/admin/CoursesConsole";

/** Console du catalogue commun de « Courses et repas » (US-164 à US-175). */
export default function AdminCoursesPage() {
  return (
    <Suspense fallback={null}>
      <CoursesConsole />
    </Suspense>
  );
}
