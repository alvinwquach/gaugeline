import groq from "groq";

// Run by hand before a market day: every menu item and pop-up with its last change.
export const exportQuery = groq`*[_type in ["menuItem", "popup"]]{ _id, _updatedAt }`;
