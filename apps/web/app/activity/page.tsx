import type { Metadata } from "next";
import { Suspense } from "react";
import { ActivityView } from "@/components/views/ActivityView";

export const metadata: Metadata = { title: "Activity" };

// ActivityView reads filters from the URL, which needs a Suspense boundary.
export default function Page() {
  return (
    <Suspense>
      <ActivityView />
    </Suspense>
  );
}
