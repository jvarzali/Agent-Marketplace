import type { Metadata } from "next";
import { AgentDetailView } from "@/components/views/AgentDetailView";

export const metadata: Metadata = { title: "Agent" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AgentDetailView id={id} />;
}
