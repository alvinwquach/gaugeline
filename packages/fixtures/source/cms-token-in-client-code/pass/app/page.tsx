import { MenuFilter } from "../components/MenuFilter";
import { draftClient } from "../lib/sanity";

export default async function Page() {
  const sections = await draftClient().fetch<string[]>('*[_type == "menuSection"].title');
  return <MenuFilter sections={sections} />;
}
