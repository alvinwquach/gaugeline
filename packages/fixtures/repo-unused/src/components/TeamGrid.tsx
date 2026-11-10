import { TeamCard } from "./TeamCard";

export function TeamGrid({ members }) {
  return (
    <section>
      {members.map((member) => (
        <TeamCard key={member.name} member={member} />
      ))}
    </section>
  );
}
