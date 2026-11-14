export function TeamCard({ member }) {
  return (
    <figure>
      <img src={member.photo} alt={member.name} />
      <figcaption>
        {member.name}, {member.role}
      </figcaption>
    </figure>
  );
}
