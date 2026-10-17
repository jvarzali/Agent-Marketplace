import type { Metadata } from "next";
import { NewAgentView } from "@/components/views/NewAgentView";

export const metadata: Metadata = { title: "Add an agent" };

export default function Page() {
  return <NewAgentView />;
}
