import { gql } from "graphql-tag";

const field = process.env.RESOURCE_FIELD ?? "title";

export const DYNAMIC = gql`
  query Dynamic {
    allResource {
      ${field}
    }
  }
`;
