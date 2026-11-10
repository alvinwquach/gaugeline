import { auth } from "@/auth";

// Reads the session to greet the patient, and renders the list whether or not there is one.
export default async function Invoices() {
  const session = await auth();
  const name = session?.user?.name ?? "there";
  return <h1>Hello {name}: your invoices</h1>;
}
