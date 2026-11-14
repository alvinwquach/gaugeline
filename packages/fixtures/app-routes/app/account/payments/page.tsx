import { redirect } from "next/navigation";
import { auth } from "@/auth";

export default async function Payments() {
  const session = await auth();
  if (!session) redirect("/login");
  return <h1>Payments for {session.user?.name}</h1>;
}
