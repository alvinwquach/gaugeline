import { TeamGrid } from "@/components/TeamGrid";
import { client } from "@/lib/client";
import { TEAM_QUERY } from "@/lib/queries";

export default async function TeamPage() {
  const team = await client.fetch(TEAM_QUERY);
  return <TeamGrid members={team} />;
}
