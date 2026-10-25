import Dashboard from "@/components/dashboard";
import { requirePageIdentity } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function WorkspacePage() {
  const physician = await requirePageIdentity();
  return <Dashboard physician={{ displayName: physician.displayName, username: physician.username }} />;
}
