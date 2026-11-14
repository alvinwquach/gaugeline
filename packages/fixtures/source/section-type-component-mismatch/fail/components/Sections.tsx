import { Hero } from "./Hero";

const components = {
  hero: Hero,
};

export function Sections({ sections }: { sections: { _key: string; _type: string }[] }) {
  return sections.map((s) => {
    const Component = components[s._type as keyof typeof components];
    return Component ? <Component key={s._key} /> : null;
  });
}
