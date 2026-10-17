import type { Metadata } from "next";
import { PolicyEditorView } from "@/components/views/PolicyEditorView";

export const metadata: Metadata = { title: "Edit rules" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PolicyEditorView id={id} />;
}
