import type { Metadata } from "next";
import { ApprovalDetailView } from "@/components/views/ApprovalDetailView";

export const metadata: Metadata = { title: "Purchase request" };

// Email and push links land here, optionally with ?intent=approve|deny. Opening the page never
// decides anything: the intent only preselects a button, and the decision is a POST.
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ intent?: string }>;
}) {
  const [{ id }, { intent }] = await Promise.all([params, searchParams]);
  return <ApprovalDetailView id={id} intent={intent === "approve" || intent === "deny" ? intent : null} />;
}
