import type { Metadata } from "next";
import { ApprovalDetailView } from "@/components/views/ApprovalDetailView";

export const metadata: Metadata = { title: "Purchase request" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ApprovalDetailView id={id} />;
}
