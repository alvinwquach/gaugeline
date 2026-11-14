import { FEATURES, type FeatureId } from "../features";

/**
 * One sentence for each view: what it will show when it arrives. Written once, here, and the same
 * words are on the app page in the docs. There is no sample data: the app shows real results or
 * says what is coming.
 */
export const WILL_SHOW: Record<FeatureId, string> = {
  pageCost: "Page cost will show what each page asks Sanity for, compared with what it shows.",
  automaticMessages: "Automatic messages will show things Sanity does by itself when you publish.",
  content:
    "Content will show everything on your site as a table, with the pages each item appears on.",
};

/** What a view that is not switched on shows: its name, why it is off and what it will be. */
export function ComingSoon({ feature }: { feature: FeatureId }) {
  const { label, note } = FEATURES[feature];
  return (
    <>
      <h1>{label}</h1>
      <p className="notice">{note}</p>
      <p>{WILL_SHOW[feature]}</p>
    </>
  );
}

/** The component a view uses until its flag is switched on and a real one replaces it in views.ts. */
export const comingSoon = (feature: FeatureId) =>
  function ComingSoonView() {
    return <ComingSoon feature={feature} />;
  };
