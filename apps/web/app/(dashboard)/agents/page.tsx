import type { Metadata } from "next";
import { AgentsView } from "@/components/views/AgentsView";

export const metadata: Metadata = { title: "Agents" };

export default function Page() {
  return <AgentsView />;
}
